import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { BackupSource } from '@nxgt/backup';
import type { Db } from 'mongodb';
import { contents, type Harness, harness, indexesOf } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { mongoSource } from './source/mongo-source';
import { mongoTarget } from './target/mongo-target';

let server: TestServer;
let h: Harness;

beforeAll(async () => {
	server = await startMongo();
});
afterAll(() => server.stop());
beforeEach(async () => {
	await server.reset();
	await server.client.db('restored').dropDatabase();
	h = await harness();
});
afterEach(() => h.remove());

const restored = () => server.client.db('restored');

const incremental = (source: BackupSource) =>
	h.backups.create(source, { kind: 'incremental', identities: [h.identity] });

async function restore(id: string, replace = false): Promise<void> {
	await h.backups.restore(id, mongoTarget({ db: restored(), replace }), {
		identities: [h.identity],
	});
}

/** `source`, with `work` run once its first entry was yielded. */
function during(
	source: BackupSource,
	work: () => Promise<unknown>,
): BackupSource {
	let done = false;
	return {
		kind: source.kind,
		async *entries(since) {
			for await (const entry of source.entries(since)) {
				if (!done) {
					done = true;
					await work();
				}
				yield entry;
			}
		},
		position: () => source.position?.(),
	};
}

describe('a full backup holds the collections and indexes of its snapshot', () => {
	test('an index built while it runs is in the next backup, not this one', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertMany([{ k: 1 }, { k: 1 }]);
		const source = mongoSource({ db });
		const full = await h.backups.create(
			during(source, async () => {
				await db.collection('b').deleteOne({ k: 1 });
				await db
					.collection('b')
					.createIndex({ k: 1 }, { unique: true, name: 'k' });
			}),
		);
		await restore(full.id);
		expect(await restored().collection('b').countDocuments()).toBe(2);
		expect((await indexesOf(restored(), 'b')).map((i) => i['name'])).toEqual([
			'_id_',
		]);

		const next = await incremental(source);
		await restored().dropDatabase();
		await restore(next.id);
		expect(await contents(restored())).toEqual(await contents(db));
		expect(await indexesOf(restored(), 'b')).toEqual(await indexesOf(db, 'b'));
	});

	test('a collection dropped while it runs is still read at the snapshot', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertOne({ n: 2 });
		const created = await h.backups.create(
			during(mongoSource({ db }), () => db.collection('b').drop()),
		);
		await restore(created.id);
		expect(Object.keys(await contents(restored()))).toEqual(['a', 'b']);
	});

	/** `db`, whose every listing of collections first creates one more. */
	function churning(db: Db, times: number): Db {
		let n = 0;
		return new Proxy(db, {
			get(target, key, receiver) {
				if (key !== 'listCollections')
					return Reflect.get(target, key, receiver);
				return (...args: Parameters<Db['listCollections']>) => ({
					toArray: async () => {
						if (n++ < times) {
							await target.createCollection(`churn-${crypto.randomUUID()}`);
						}
						return target.listCollections(...args).toArray();
					},
				});
			},
		});
	}

	test('a collection gone between its listing and its indexes is listed again', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		let failed = false;
		const vanishing = new Proxy(db, {
			get(target, key, receiver) {
				if (key !== 'collection') return Reflect.get(target, key, receiver);
				return (name: string) => {
					const collection = target.collection(name);
					if (failed || name !== 'a') return collection;
					return new Proxy(collection, {
						get(c, k, r) {
							if (k !== 'listIndexes') return Reflect.get(c, k, r);
							failed = true;
							return () => ({
								toArray: () =>
									Promise.reject(
										Object.assign(new Error('gone'), { code: 26 }),
									),
							});
						},
					});
				};
			},
		});
		const created = await h.backups.create(mongoSource({ db: vanishing }));
		expect(failed).toBe(true);
		await restore(created.id);
		expect(Object.keys(await contents(restored()))).toEqual(['a']);
	});

	test('the collections are read again until they hold still, then CHANGING', async () => {
		await server.db.collection('a').insertOne({ n: 1 });
		const settled = await h.backups.create(
			mongoSource({ db: churning(server.db, 3) }),
		);
		expect(settled.entries).toBeGreaterThan(2);

		const error = await rejection(
			h.backups.create(mongoSource({ db: churning(server.db, 1000) })),
		);
		expect(error).toHaveProperty('code', 'CHANGING');
		// An index changing is a change too, however the collections stand.
		const indexing = new Proxy(server.db, {
			get(target, key, receiver) {
				if (key !== 'collection') return Reflect.get(target, key, receiver);
				return (name: string) => {
					const collection = target.collection(name);
					return new Proxy(collection, {
						get(c, k, r) {
							if (k !== 'listIndexes') return Reflect.get(c, k, r);
							return () => ({
								toArray: async () => {
									await c.createIndex({
										[`f${crypto.randomUUID().slice(0, 8)}`]: 1,
									});
									return c.listIndexes().toArray();
								},
							});
						},
					});
				};
			},
		});
		const indexed = await rejection(
			h.backups.create(mongoSource({ db: indexing })),
		);
		expect(indexed).toHaveProperty('code', 'CHANGING');
		expect(error).toHaveProperty(
			'message',
			'mongoSource: the collections or their indexes kept changing while the ' +
				'snapshot was taken; try again when they settle',
		);
	});
});

describe('a rename the changes replay', () => {
	test('does not replace a collection it did not replace at the source', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.collection('a').rename('b');
		const created = await incremental(source);
		await restored().collection('b').insertOne({ foreign: true });
		const error = await rejection(restore(created.id));
		expect(error).toHaveProperty('code', 'EXISTS');
		expect(
			await restored().collection('b').countDocuments({ foreign: true }),
		).toBe(1);

		await restored().dropDatabase();
		await restored().collection('b').insertOne({ foreign: true });
		await restore(created.id, true);
		expect(await contents(restored())).toEqual(await contents(db));
	});

	test('replaces the one it replaced at the source', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertOne({ n: 2 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.collection('a').rename('b', { dropTarget: true });
		const created = await incremental(source);
		await restore(created.id);
		expect(await contents(restored())).toEqual(await contents(db));
	});
});

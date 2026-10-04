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
import { BSON, type Db, type Document } from 'mongodb';
import { contents, type Harness, harness, indexesOf } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { bsonDocuments } from './format/bson-stream';
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

/** Documents whose `_id` is a number, as these specs write them. */
type Numbered = { _id?: number; tags?: number[] } & Record<string, unknown>;

const incremental = (
	source: BackupSource,
	kind: 'incremental' | 'differential' = 'incremental',
) => h.backups.create(source, { kind, identities: [h.identity] });

async function restore(id: string, db: Db = restored()): Promise<void> {
	await db.dropDatabase();
	await h.backups.restore(id, mongoTarget({ db }), {
		identities: [h.identity],
	});
}

/** How many changes one `changes/<n>` entry of a backup records. */
async function changeCount(id: string, name: string): Promise<number> {
	let count = 0;
	await h.backups.restore(
		id,
		{
			async write(_name, stream) {
				for await (const _ of bsonDocuments(stream, 'spec')) count++;
			},
		},
		{ identities: [h.identity], only: [name] },
	);
	return count;
}

/** What the restore must reproduce: documents, indexes and options. */
async function shape(db: Db) {
	const collections = await db.listCollections().toArray();
	const described: Record<string, unknown> = {};
	for (const info of collections.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (info.name.startsWith('system.')) continue;
		const { uuid: _uuid, ...options } =
			(info as { options?: Record<string, unknown> }).options ?? {};
		described[info.name] = {
			type: info.type,
			options,
			indexes: info.type === 'view' ? [] : await indexesOf(db, info.name),
		};
	}
	return { described, contents: await contents(db) };
}

describe('an incremental backup', () => {
	test('replays every kind of change since the full one', async () => {
		const { db } = server;
		const people = db.collection<Numbered>('people');
		await people.insertMany([
			{ _id: 1, name: 'a', tags: [1, 2, 3, 4], gone: true },
			{ _id: 2, name: 'b' },
			{ _id: 3, name: 'c' },
		]);
		await db.collection<Numbered>('old').insertOne({ n: 1 });
		await db.collection<Numbered>('doomed').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);

		await people.updateOne(
			{ _id: 1 },
			{ $set: { name: 'A', n: new BSON.Int32(7) }, $unset: { gone: '' } },
		);
		await people.updateOne({ _id: 1 }, { $pop: { tags: 1 } } as Document);
		await people.updateOne({ _id: 1 }, [
			{ $set: { tags: { $slice: ['$tags', 2] } } },
		]);
		await people.replaceOne(
			{ _id: 2 },
			{ name: 'B', big: BSON.Long.fromNumber(5) },
		);
		await people.deleteOne({ _id: 3 });
		await people.insertOne({
			_id: 4,
			price: BSON.Decimal128.fromString('1.10'),
		});
		await db.createCollection('fresh', {
			validator: { $jsonSchema: { required: ['k'] } },
			collation: { locale: 'fr' },
		});
		await db
			.collection<Numbered>('fresh')
			.createIndex({ k: 1 }, { name: 'k', unique: true });
		await db.collection<Numbered>('fresh').insertOne({ k: 1 });
		await people.createIndex({ name: 1 }, { name: 'by_name' });
		await people.createIndex({ n: 1 }, { name: 'by_n' });
		await people.dropIndex('by_n');
		await db.command({
			collMod: 'people',
			index: { name: 'by_name', hidden: true },
		});
		await db.collection<Numbered>('old').rename('renamed');
		await db.collection<Numbered>('doomed').drop();
		await db.createCollection('named', {
			viewOn: 'people',
			pipeline: [{ $project: { name: 1 } }],
		});

		const created = await incremental(source);
		expect(created).toMatchObject({
			kind: 'incremental',
			entries: 7,
			reused: 6,
		});
		await restore(created.id);
		expect(await shape(restored())).toEqual(await shape(db));
	});

	test('chains: an incremental on an incremental, and a differential on the full one', async () => {
		const { db } = server;
		const source = mongoSource({ db });
		await db.collection<Numbered>('a').insertOne({ _id: 1, n: 1 });
		const full = await h.backups.create(source);
		await db.collection<Numbered>('a').insertOne({ _id: 2, n: 2 });
		const first = await incremental(source);
		await db
			.collection<Numbered>('a')
			.updateOne({ _id: 1 }, { $set: { n: 10 } });
		const second = await incremental(source);
		expect(second).toMatchObject({ parent: first.id, entries: 4 });
		await restore(second.id);
		expect(await contents(restored())).toEqual(await contents(db));

		await db.collection<Numbered>('a').deleteOne({ _id: 2 });
		const differential = await incremental(source, 'differential');
		expect(differential).toMatchObject({ parent: full.id, entries: 3 });
		await restore(differential.id);
		expect(await contents(restored())).toEqual(await contents(db));
	});

	test('reads no further than the time it started, and the next one picks up from there', async () => {
		const { db } = server;
		await db.collection<Numbered>('a').insertOne({ _id: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.collection<Numbered>('a').insertOne({ _id: 2 });
		let written = false;
		const late: BackupSource = {
			kind: source.kind,
			async *entries(since) {
				for await (const entry of source.entries(since)) {
					if (!written) {
						written = true;
						await db.collection<Numbered>('a').insertOne({ _id: 3 });
					}
					yield entry;
				}
			},
			position: () => source.position?.(),
		};
		const first = await incremental(late);
		await restore(first.id);
		const ids = async () =>
			(
				await restored()
					.collection<Numbered>('a')
					.find()
					.sort({ _id: 1 })
					.toArray()
			).map((d) => d._id);
		expect(await ids()).toEqual([1, 2]);
		const second = await incremental(source);
		await restore(second.id);
		expect(await ids()).toEqual([1, 2, 3]);
		// It starts after the last change the first one read: one record, not three.
		expect(await changeCount(second.id, 'changes/000002')).toBe(1);
	});

	test('applies changes to several collections, and a drop, in their order', async () => {
		const { db } = server;
		await db.collection<Numbered>('a').insertOne({ _id: 0 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		for (let n = 1; n <= 3; n++) {
			await db.collection<Numbered>('a').insertOne({ _id: n });
			await db.collection<Numbered>('b').insertOne({ _id: n });
		}
		await db.collection<Numbered>('gone').insertOne({ _id: 1 });
		await db.collection<Numbered>('gone').drop();
		const created = await incremental(source);
		await restore(created.id);
		expect(await contents(restored())).toEqual(await contents(db));
		expect(Object.keys(await contents(restored()))).toEqual(['a', 'b']);
	});

	test('an incremental with nothing changed restores what the full one held', async () => {
		const { db } = server;
		await db.collection<Numbered>('a').insertOne({ _id: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		const created = await incremental(source);
		await restore(created.id);
		expect(await contents(restored())).toEqual(await contents(db));
		const again = await incremental(source);
		expect(again.parent).toBe(created.id);
	});
});

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
import { contents, type Harness, harness } from '../test/fixtures';
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

describe('the collections a chain follows', () => {
	test('are those of its full backup: a wider filter waits for the next full one', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertOne({ n: 1 });
		await h.backups.create(mongoSource({ db, collections: ['a'] }));
		await db.collection('b').insertOne({ n: 2 });
		await db.collection('a').insertOne({ n: 2 });
		const created = await incremental(
			mongoSource({ db, collections: ['a', 'b'] }),
		);
		await restore(created.id);
		expect(Object.keys(await contents(restored()))).toEqual(['a']);
		expect(await restored().collection('a').countDocuments()).toBe(2);
	});

	test('and a narrower one does not drop one out halfway', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertOne({ n: 1 });
		await h.backups.create(mongoSource({ db }));
		await db.collection('b').insertOne({ n: 2 });
		const created = await incremental(mongoSource({ db, collections: ['a'] }));
		await restore(created.id);
		expect(await contents(restored())).toEqual(await contents(db));
	});

	test('follow renames, drops and a dropped database', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('c').insertOne({ n: 1 });
		await h.backups.create(mongoSource({ db }));
		// Renamed, then written under its new name in the same incremental.
		await db.collection('a').rename('b');
		await db.collection('b').insertOne({ n: 2 });
		await db.collection('c').drop();
		const renamed = await incremental(mongoSource({ db }));
		await restore(renamed.id);
		expect(await restored().collection('b').countDocuments()).toBe(2);

		// What was renamed away or dropped is followed no more.
		const narrower = mongoSource({
			db,
			collections: (n) => n !== 'a' && n !== 'c',
		});
		await db.collection('a').insertOne({ n: 3 });
		await db.collection('c').insertOne({ n: 3 });
		const after = await incremental(narrower);
		await restored().dropDatabase();
		await restore(after.id);
		expect(Object.keys(await contents(restored()))).toEqual(['b']);

		// Nor is anything once the database was dropped.
		await db.dropDatabase();
		await incremental(narrower);
		await db.collection('b').insertOne({ n: 4 });
		const dropped = await incremental(
			mongoSource({ db, collections: (n) => n !== 'b' }),
		);
		await restored().dropDatabase();
		await restore(dropped.id);
		expect(await contents(restored())).toEqual({});
	});

	test('take in a collection created since, when the filter takes it', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db, collections: (n) => n !== 'skip' });
		await h.backups.create(source);
		await db.collection('fresh').insertOne({ n: 1 });
		await db.collection('skip').insertOne({ n: 1 });
		const first = await incremental(source);
		await db.collection('fresh').insertOne({ n: 2 });
		const second = await incremental(source);
		expect(second.parent).toBe(first.id);
		await restore(second.id);
		expect(Object.keys(await contents(restored()))).toEqual(['a', 'fresh']);
		expect(await restored().collection('fresh').countDocuments()).toBe(2);
	});
});

describe('the collections an incremental backup takes', () => {
	test('a rename out of them is a drop, and one into them is refused', async () => {
		const { db } = server;
		await db.collection('kept').insertOne({ n: 1 });
		await db.collection('other').insertOne({ n: 1 });
		const source = mongoSource({
			db,
			collections: (name) => name.startsWith('kept'),
		});
		await h.backups.create(source);
		await db.collection('kept').rename('away');
		const out = await incremental(source);
		await restore(out.id);
		expect(Object.keys(await contents(restored()))).toEqual([]);

		await db.collection('other').rename('kept-too');
		const error = await rejection(incremental(source));
		expect(error).toHaveProperty('code', 'UNSUPPORTED');
		expect(error).toHaveProperty(
			'message',
			'mongoSource: a collection was renamed into those backed up, with ' +
				'documents an incremental backup never read; make a full backup',
		);
	});

	test('a change to a collection left out is not recorded', async () => {
		const { db } = server;
		await db.collection('kept').insertOne({ n: 1 });
		const source = mongoSource({ db, collections: ['kept'] });
		await h.backups.create(source);
		await db.collection('other').insertOne({ n: 1 });
		await db.collection('kept').insertOne({ n: 2 });
		const created = await incremental(source);
		await restore(created.id);
		expect(Object.keys(await contents(restored()))).toEqual(['kept']);
		expect(await restored().collection('kept').countDocuments()).toBe(2);
	});
});

describe('a collection the changes create', () => {
	test('is refused when the restore finds it there, and replaced with replace', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.collection('b').insertOne({ n: 2 });
		const created = await incremental(source);
		await restored().collection('b').insertOne({ mine: true });
		const error = await rejection(
			h.backups.restore(created.id, mongoTarget({ db: restored() }), {
				identities: [h.identity],
			}),
		);
		expect(error).toHaveProperty('code', 'EXISTS');
		await restored().dropDatabase();
		await restored().collection('b').insertOne({ mine: true });
		await h.backups.restore(
			created.id,
			mongoTarget({ db: restored(), replace: true }),
			{ identities: [h.identity] },
		);
		expect(await contents(restored())).toEqual(await contents(db));
	});

	test('renamed into another database, is gone from this one', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await server.client.db('admin').command({
			renameCollection: `${db.databaseName}.a`,
			to: 'elsewhere.a',
		});
		const created = await incremental(source);
		await restore(created.id);
		expect(await contents(restored())).toEqual({});
		await server.client.db('elsewhere').dropDatabase();
	});
});

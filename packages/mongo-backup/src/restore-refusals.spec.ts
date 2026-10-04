import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { MongoClient } from 'mongodb';
import { contents, type Harness, harness } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { chain, scratchLeft } from '../test/restore';
import { restoreCollections } from './restore/restore-collections';

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

describe('restoreCollections refuses', () => {
	test('an as record it cannot use before the backup is read', async () => {
		const never = {
			restore: () => Promise.reject(new Error('the backup was read')),
		};
		for (const as of [{ a: 'x', b: 'x' }, { a: 'system.x' }]) {
			const error = await rejection(
				restoreCollections(never, 'id', {
					identities: [],
					db: restored(),
					as,
				}),
			);
			expect(error).toBeInstanceOf(TypeError);
		}
	});

	test('under its own name what the target behind it refuses', async () => {
		const never = {
			restore: () => Promise.reject(new Error('the backup was read')),
		};
		const error = await rejection(
			restoreCollections(never, 'id', {
				identities: [],
				db: restored(),
				tmpDir: 'relative',
			}),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(error).toHaveProperty(
			'message',
			'restoreCollections: tmpDir must be an absolute path',
		);
		expect((error as Error).cause).toHaveProperty(
			'message',
			'mongoTarget: tmpDir must be an absolute path',
		);
	});

	test('a collection the backup lacks, and a scratch database not empty', async () => {
		const id = await chain(server.db, h);
		const missing = await rejection(
			restoreCollections(h.backups, id, {
				identities: [h.identity],
				db: restored(),
				collections: ['a'],
			}),
		);
		expect(missing).toHaveProperty('code', 'NOT_FOUND');
		expect(missing).toHaveProperty(
			'message',
			'restoreCollections: a collection named in collections is not in the backup',
		);
		expect(await scratchLeft(server.client)).toEqual([]);

		const scratch = server.client.db('nxgt-restore-mine');
		await scratch.collection('kept').insertOne({ n: 1 });
		const full = await rejection(
			restoreCollections(h.backups, id, {
				identities: [h.identity],
				db: restored(),
				scratch,
			}),
		);
		expect(full).toHaveProperty('code', 'EXISTS');
		const system = await rejection(
			restoreCollections(h.backups, id, {
				identities: [h.identity],
				db: restored(),
				collections: ['system.views'],
			}),
		);
		expect(system).toHaveProperty('code', 'NOT_FOUND');
		expect(await scratch.collection('kept').countDocuments()).toBe(1);
		await scratch.dropDatabase();
	});

	test('options it cannot use, before reading anything — a function as once the names are known', async () => {
		const id = await chain(server.db, h);
		const base = { identities: [h.identity], db: restored() };
		const cases: [Record<string, unknown>, string][] = [
			[{ db: {} }, 'restoreCollections: db must be a MongoDB Db'],
			[{ scratch: {} }, 'restoreCollections: scratch must be a MongoDB Db'],
			[
				{ scratch: new MongoClient('mongodb://127.0.0.1:1').db('x') },
				"restoreCollections: scratch must be on db's client",
			],
			[
				{ scratch: server.client.db('restored') },
				'restoreCollections: scratch must be another database',
			],
			[
				{ documents: { filter: [], existing: 'keep' } },
				"restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }",
			],
			[
				{ documents: { filter: {}, existing: 'merge' } },
				"restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }",
			],
			[
				{ documents: { filter: {}, existing: 'keep' }, replace: true },
				'restoreCollections: replace is for whole collections; documents says what happens to those there',
			],
		];
		for (const [options, message] of cases) {
			const error = await rejection(
				restoreCollections(h.backups, id, { ...base, ...options } as never),
			);
			expect(error).toBeInstanceOf(TypeError);
			expect(error).toHaveProperty('message', message);
		}
		for (const [as, message] of [
			[() => 'same', 'restoreCollections: as gives two collections one name'],
			[
				{ a: 'x', b: 'x' },
				'restoreCollections: as gives two collections one name',
			],
			[
				{ orders: 'system.x' },
				'restoreCollections: as must give a collection name',
			],
			[{ orders: 'a$b' }, 'restoreCollections: as must give a collection name'],
			[{ orders: '' }, 'restoreCollections: as must give a collection name'],
			[() => 5, 'restoreCollections: as must give a collection name'],
			[
				{ order: 'x' },
				'restoreCollections: as names a collection not restored',
			],
		] as const) {
			const error = await rejection(
				restoreCollections(h.backups, id, { ...base, as: as as never }),
			);
			expect(error).toBeInstanceOf(TypeError);
			expect(error).toHaveProperty('message', message);
		}
		expect(await contents(restored())).toEqual({});
		expect(await scratchLeft(server.client)).toEqual([]);
	});
});

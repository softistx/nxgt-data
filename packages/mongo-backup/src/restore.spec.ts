import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { contents, type Harness, harness, indexesOf } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { blind, chain, scratchLeft } from '../test/restore';
import { restoreCollections } from './restore/restore-collections';
import { mongoSource } from './source/mongo-source';

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

type Numbered = { _id: number } & Record<string, unknown>;

describe('restoreCollections, whole', () => {
	test('restores some collections and views under other names, chain included', async () => {
		const id = await chain(server.db, h);
		const done = await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db: restored(),
			collections: ['orders', 'ones'],
			as: { orders: 'orders-then' },
		});
		expect(done.collections).toEqual([
			{ name: 'ones', as: 'ones' },
			{ name: 'orders', as: 'orders-then' },
		]);
		expect(await contents(restored())).toEqual({
			ones: (await contents(server.db))['ones'] as string,
			'orders-then': (await contents(server.db))['orders'] as string,
		});
		expect(await indexesOf(restored(), 'orders-then')).toHaveLength(2);
		const [view] = await restored().listCollections({ name: 'ones' }).toArray();
		expect(view).toHaveProperty('options.viewOn', 'orders-then');
		expect(await scratchLeft(server.client)).toEqual([]);
	});

	test('refuses a name taken unless replace, and moves nothing', async () => {
		const id = await chain(server.db, h);
		await restored().collection('other').insertOne({ foreign: true });
		await restored().createCollection('ones', {
			viewOn: 'other',
			pipeline: [],
		});
		const error = await rejection(
			restoreCollections(h.backups, id, {
				identities: [h.identity],
				db: restored(),
			}),
		);
		expect(error).toHaveProperty('code', 'EXISTS');
		expect(error).toHaveProperty(
			'message',
			'restoreCollections: a collection or view to restore is already in the ' +
				'database; restore it under another name, or pass replace: true',
		);
		expect(Object.keys(await contents(restored()))).toEqual(['ones', 'other']);
		expect(await scratchLeft(server.client)).toEqual([]);

		await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db: restored(),
			replace: true,
		});
		expect(await contents(restored())).toEqual(await contents(server.db));
	});

	test('refuses a name taken between its check and the move, rather than replace it', async () => {
		const id = await chain(server.db, h);
		await restored().collection('orders').insertOne({ foreign: true });
		await restored().collection('ones').insertOne({ foreign: true });
		for (const collections of [['orders'], ['ones']]) {
			const error = await rejection(
				restoreCollections(h.backups, id, {
					identities: [h.identity],
					db: blind(restored()),
					collections,
				}),
			);
			expect(error).toHaveProperty('code', 'EXISTS');
		}
		expect(await restored().collection('orders').countDocuments()).toBe(1);
		expect(await restored().collection('ones').countDocuments()).toBe(1);
	});

	test('replaces a view with a collection, from a given scratch database it then drops', async () => {
		const id = await chain(server.db, h);
		await restored().createCollection('orders', {
			viewOn: 'elsewhere',
			pipeline: [],
		});
		const done = await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db: restored(),
			collections: (name) => name === 'orders',
			replace: true,
			scratch: server.client.db('nxgt-restore-given'),
		});
		expect(done.collections).toEqual([{ name: 'orders', as: 'orders' }]);
		expect(await contents(restored())).toEqual({
			orders: (await contents(server.db))['orders'] as string,
		});
		expect(await scratchLeft(server.client)).toEqual([]);
	});
});

describe('a whole restore into the database a chain follows', () => {
	test('is followed by the next incremental, unless the chain follows a list', async () => {
		const { db } = server;
		for (const collections of [undefined, ['orders']]) {
			const own = await harness();
			await db.collection('orders').insertMany([{ n: 1 }, { n: 2 }]);
			const source = mongoSource({ db, collections });
			const full = await own.backups.create(source);
			await db.collection('orders').drop();
			await restoreCollections(own.backups, full.id, {
				identities: [own.identity],
				db,
			});
			const next = own.backups.create(source, {
				kind: 'incremental',
				identities: [own.identity],
			});
			if (collections) {
				// The server moves it through a temporary collection the list does not name.
				expect(await rejection(next)).toHaveProperty('code', 'UNSUPPORTED');
			} else {
				await restoreCollections(own.backups, (await next).id, {
					identities: [own.identity],
					db: restored(),
				});
				expect(await contents(restored())).toEqual(await contents(db));
			}
			await own.remove();
			await server.reset();
		}
	});
});

describe('restoreCollections, documents', () => {
	test('merges the documents a filter takes into what is there', async () => {
		const { db } = server;
		const people = db.collection<Numbered>('people');
		await people.insertMany([
			{ _id: 1, name: 'a' },
			{ _id: 2, name: 'b' },
			{ _id: 3, name: 'c' },
		]);
		await people.createIndex({ name: 1 }, { name: 'by_name' });
		await db.createCollection('named', { viewOn: 'people', pipeline: [] });
		const { id } = await h.backups.create(mongoSource({ db }));
		await people.deleteOne({ _id: 1 });
		await people.updateOne({ _id: 2 }, { $set: { name: 'B' } });
		const selection = { filter: { _id: { $in: [1, 2] } } };

		const kept = await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db,
			documents: { ...selection, existing: 'keep' },
		});
		// The view holds no documents: it is not one of those restored.
		expect(kept.collections).toEqual([
			{ name: 'people', as: 'people', documents: 2 },
		]);
		const names = async () =>
			(await people.find().sort({ _id: 1 }).toArray()).map((p) => p['name']);
		expect(await names()).toEqual(['a', 'B', 'c']);

		await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db,
			documents: { ...selection, existing: 'replace' },
		});
		expect(await names()).toEqual(['a', 'b', 'c']);
		// One made between the check and the merge, with options of its own,
		// is merged into as it is.
		await restored().createCollection('people', {
			validator: { never: { $exists: true } },
		});
		await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db: blind(restored()),
			documents: { filter: { _id: 1 }, existing: 'keep' },
		});
		expect(await contents(restored())).toEqual({
			people: '[{"_id":{"$numberInt":"1"},"name":"a"}]',
		});
		await restored().dropDatabase();

		// A collection not there is made with the backup's options and indexes.
		await restoreCollections(h.backups, id, {
			identities: [h.identity],
			db: restored(),
			as: (name) => `${name}-1`,
			documents: { filter: { _id: 3 }, existing: 'keep' },
		});
		expect(await contents(restored())).toEqual({
			'people-1': '[{"_id":{"$numberInt":"3"},"name":"c"}]',
		});
		expect(await indexesOf(restored(), 'people-1')).toEqual(
			await indexesOf(db, 'people'),
		);
		expect(await scratchLeft(server.client)).toEqual([]);
	});
});

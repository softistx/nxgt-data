import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { rejectionMessage } from '../../test/rejection';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { resetAutoSync } from './auto-sync';
import { getCollection } from './get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-auto-sync');
}, 120_000);
beforeEach(async () => {
	await t.reset();
	// Dropping the database does not undo the memo: without this, the next
	// case would think the collection it can no longer see is already synced.
	resetAutoSync(t.db);
});
afterAll(() => t.stop());

const invoices = defineCollection({
	name: 'invoices',
	schema: z.object({ _id: id(), total: z.number() }),
	indexes: [{ key: { total: 1 }, name: 'invoices_total' }],
	timestamps: true,
});

const indexNames = async () =>
	(await t.db.collection('invoices').indexes()).map((i) => i.name).sort();

describe('autoSync', () => {
	test('the first operation finds the collection already there', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		await collection.create({ total: 10 });
		expect(await indexNames()).toEqual(['_id_', 'invoices_total']);
		// And the validator went with it: this is not MongoDB's implicit create.
		const [info] = await t.db
			.listCollections({ name: 'invoices' }, { nameOnly: false })
			.toArray();
		expect(info?.options?.validator).toBeDefined();
	});

	test('concurrent operations all wait for the one sync', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		const written = await Promise.all([
			collection.create({ total: 1 }),
			collection.create({ total: 2 }),
			collection.create({ total: 3 }),
		]);
		expect(written).toHaveLength(3);
		expect(await collection.count()).toBe(3);
	});

	test('it syncs once, not before every call', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		await collection.create({ total: 10 });
		// Take the index away behind its back. A collection that synced again
		// would put it straight back.
		await t.db.collection('invoices').dropIndex('invoices_total');
		await collection.create({ total: 20 });
		expect(await indexNames()).toEqual(['_id_']);
	});

	test('a scoped collection shares it rather than syncing again', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		await collection.create({ total: 10 });
		await t.db.collection('invoices').dropIndex('invoices_total');
		await collection.withSession(undefined).create({ total: 20 });
		expect(await indexNames()).toEqual(['_id_']);
	});

	test('forgetting the syncs makes the next call sync again', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		await collection.create({ total: 10 });
		await t.db.collection('invoices').dropIndex('invoices_total');
		// The collection is the same object: the sync is looked up per call,
		// so forgetting it reaches one somebody is already holding.
		resetAutoSync(t.db);
		await collection.create({ total: 20 });
		expect(await indexNames()).toEqual(['_id_', 'invoices_total']);
	});

	test('without a database, it forgets every one of them', async () => {
		const collection = getCollection(t.db, invoices, { autoSync: true });
		await collection.create({ total: 10 });
		await t.db.collection('invoices').dropIndex('invoices_total');
		resetAutoSync();
		await collection.create({ total: 20 });
		expect(await indexNames()).toEqual(['_id_', 'invoices_total']);
	});

	test('a sync that failed is tried again, not remembered', async () => {
		// A plain `audit` is already there; the definition wants it capped,
		// which sync refuses to pretend it did.
		await t.db.createCollection('audit');
		const audit = defineCollection({
			name: 'audit',
			schema: z.object({ _id: id(), message: z.string() }),
			options: { capped: { size: 4096 } },
		});
		const collection = getCollection(t.db, audit, { autoSync: true });
		expect(
			await rejectionMessage(collection.create({ message: 'a' })),
		).toContain('options MongoDB cannot change');

		// Once the collection is out of the way, the next call syncs again
		// rather than failing forever on the first answer.
		await t.db.collection('audit').drop();
		await collection.create({ message: 'b' });
		const [info] = await t.db
			.listCollections({ name: 'audit' }, { nameOnly: false })
			.toArray();
		expect(info?.options?.capped).toBe(true);
	});

	test('off by default: nothing is created ahead of the write', async () => {
		const collection = getCollection(t.db, invoices);
		await collection.create({ total: 10 });
		// MongoDB made the collection on the insert, with no index of ours.
		expect(await indexNames()).toEqual(['_id_']);
	});
});

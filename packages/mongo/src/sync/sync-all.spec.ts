import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { clearCollectionRegistry, registeredCollections } from './registry';
import { syncAll } from './sync-all';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-sync-all');
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

describe('the registry', () => {
	test('defining a collection is what registers it', () => {
		clearCollectionRegistry();
		expect(registeredCollections()).toEqual([]);

		const invoices = defineCollection({
			name: 'invoices',
			schema: z.object({ _id: id(), total: z.number() }),
		});
		expect(registeredCollections()).toEqual([invoices]);
	});

	test('the last definition under a name wins', () => {
		// Two definitions of one collection is a mistake, but a module being
		// evaluated twice is not — and this package cannot tell them apart.
		clearCollectionRegistry();
		defineCollection({ name: 'invoices', schema: z.object({ _id: id() }) });
		const second = defineCollection({
			name: 'invoices',
			schema: z.object({ _id: id(), total: z.number() }),
		});
		expect(registeredCollections()).toEqual([second]);
	});
});

describe('syncAll', () => {
	test('syncs every registered collection, with no list to keep', async () => {
		clearCollectionRegistry();
		defineCollection({
			name: 'invoices',
			schema: z.object({ _id: id(), total: z.number() }),
			indexes: [{ key: { total: 1 }, name: 'invoices_total' }],
			timestamps: true,
		});
		defineCollection({
			name: 'clients',
			schema: z.object({ _id: id(), name: z.string() }),
		});

		const reports = await syncAll(t.db);
		expect(reports.map((r) => [r.name, r.created])).toEqual([
			['invoices', true],
			['clients', true],
		]);
		const names = (await t.db.listCollections().toArray())
			.map((c) => c.name)
			.sort();
		expect(names).toEqual(['clients', 'invoices']);

		// And a second run sends nothing.
		const again = await syncAll(t.db);
		expect(again.flatMap((r) => r.indexes.created)).toEqual([]);
	});

	test('a dry run creates nothing', async () => {
		clearCollectionRegistry();
		defineCollection({ name: 'invoices', schema: z.object({ _id: id() }) });
		const [report] = await syncAll(t.db, { dryRun: true });
		expect(report?.created).toBe(true);
		expect(await t.db.listCollections().toArray()).toEqual([]);
	});
});

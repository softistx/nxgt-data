import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { rejection } from '../../../test/rejection';
import { startMongo, type TestServer } from '../../../test/server';
import { defineCollection } from '../../definition/define-collection';
import { id } from '../../definition/fields';
import { InvalidCursorError } from '../../errors/data-error';
import { decodeCursor } from '../../pagination/cursor';
import { getCollection } from '../get-collection';

const items = defineCollection({
	name: 'nested_items',
	schema: z.object({
		_id: id(),
		name: z.string(),
		quantity: z.object({
			baseQuantity: z.number().nullable().default(null),
			unit: z.string().default('u'),
		}),
		meta: z.object({ seenAt: z.date().optional() }).default({}),
	}),
});

let t: TestServer;
beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** 12 items: baseQuantity 0…3 with ties, names i01…i12. */
async function seed() {
	const collection = getCollection(t.db, items);
	await collection.sync();
	await collection.createMany(
		Array.from({ length: 12 }, (_, i) => ({
			name: `i${String(i + 1).padStart(2, '0')}`,
			quantity: { baseQuantity: i % 4 },
			meta: { seenAt: new Date(Date.UTC(2026, 0, 1 + (i % 3))) },
		})),
	);
	return collection;
}

async function walk(
	collection: Awaited<ReturnType<typeof seed>>,
	opts:
		| { orderBy: never; direction?: 'asc' | 'desc' }
		| Record<string, unknown>,
	limit = 5,
) {
	const rows: { name: string; q: number | null }[] = [];
	let after: string | null = null;
	let pages = 0;
	do {
		const page: Awaited<ReturnType<typeof collection.paginateByCursor>> =
			await collection.paginateByCursor({ ...opts, limit, after } as never);
		pages++;
		for (const row of page.items) {
			rows.push({ name: row.name, q: row.quantity.baseQuantity });
		}
		after = page.nextCursor;
	} while (after);
	return { rows, pages };
}

describe('paginateByCursor orderBy a nested field', () => {
	test('orders by a dotted path, ties broken by _id, with no gap or repeat', async () => {
		const collection = await seed();
		const { rows, pages } = await walk(collection, {
			orderBy: 'quantity.baseQuantity',
		});
		expect(pages).toBe(3);
		expect(rows).toHaveLength(12);
		expect(new Set(rows.map((r) => r.name)).size).toBe(12);
		expect(rows.map((r) => r.q)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
		// _id tiebreak: insertion order inside a tie.
		expect(rows.filter((r) => r.q === 0).map((r) => r.name)).toEqual([
			'i01',
			'i05',
			'i09',
		]);
	});

	test('descending walks the same set backwards', async () => {
		const collection = await seed();
		const { rows } = await walk(collection, {
			orderBy: 'quantity.baseQuantity',
			direction: 'desc',
		});
		expect(rows.map((r) => r.q)).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0]);
		expect(new Set(rows.map((r) => r.name)).size).toBe(12);
	});

	test('the cursor carries the nested value and its tiebreak', async () => {
		const collection = await seed();
		const page = await collection.paginateByCursor({
			orderBy: 'quantity.baseQuantity',
			limit: 4,
		} as never);
		const { key, values } = decodeCursor(page.nextCursor as string);
		expect(key).toBe('quantity.baseQuantity:asc');
		expect(values).toHaveLength(2);
		expect(values[0]).toBe(1);
		expect(String(values[1])).toBe(String(page.items.at(-1)?._id));
	});

	test('a nested Date value survives the cursor round trip', async () => {
		const collection = await seed();
		const { rows } = await walk(collection, { orderBy: 'meta.seenAt' }, 5);
		expect(new Set(rows.map((r) => r.name)).size).toBe(12);
	});

	test('nested nulls are resumed like top-level ones', async () => {
		const collection = getCollection(t.db, items);
		await collection.sync();
		await collection.createMany(
			Array.from({ length: 6 }, (_, i) => ({
				name: `n${i}`,
				quantity: { baseQuantity: i % 2 === 0 ? null : i },
			})),
		);
		for (const direction of ['asc', 'desc'] as const) {
			const { rows } = await walk(
				collection,
				{ orderBy: 'quantity.baseQuantity', direction },
				2,
			);
			expect(new Set(rows.map((r) => r.name)).size).toBe(6);
		}
	});

	test('a cursor written for another ordering is refused', async () => {
		const collection = await seed();
		const page = await collection.paginateByCursor({
			orderBy: 'quantity.baseQuantity',
			limit: 2,
		} as never);
		const error = await rejection(
			collection.paginateByCursor({
				orderBy: 'name',
				after: page.nextCursor,
			}),
		);
		expect(error).toBeInstanceOf(InvalidCursorError);
	});

	test('a path whose head is not a field is refused', async () => {
		const collection = await seed();
		const error = await rejection(
			collection.paginateByCursor({ orderBy: 'nope.baseQuantity' } as never),
		);
		expect(error).toBeInstanceOf(TypeError);
	});
});

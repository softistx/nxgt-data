import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { posts, users } from '../../../test/schema';
import { startMongo, type TestServer } from '../../../test/server';
import { InvalidCursorError } from '../../errors/data-error';
import { encodeCursor } from '../../pagination/cursor';
import { getCollection } from '../get-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** 25 posts: titles p01…p25, ranks 0…4 with ties. */
async function seedPosts() {
	const collection = getCollection(t.db, posts);
	await collection.sync();
	await collection.createMany(
		Array.from({ length: 25 }, (_, i) => ({
			title: `p${String(i + 1).padStart(2, '0')}`,
			rank: i % 5,
		})),
	);
	return collection;
}

async function walk(
	next: (
		after: string | null,
	) => Promise<{ items: { title: string }[]; nextCursor: string | null }>,
) {
	const pages: string[][] = [];
	let after: string | null = null;
	do {
		const page = await next(after);
		pages.push(page.items.map((post) => post.title));
		after = page.nextCursor;
	} while (after);
	return pages;
}

describe('paginate', () => {
	test('returns a page, the total and the page count', async () => {
		const collection = await seedPosts();
		const page = await collection.paginate({
			page: 2,
			pageSize: 10,
			sort: { title: 1 },
		});
		expect(page.items[0]?.title).toBe('p11');
		expect(page.items).toHaveLength(10);
		expect(page).toMatchObject({
			total: 25,
			page: 2,
			pageSize: 10,
			pageCount: 3,
		});
	});

	test('the last page is partial, and past it is empty', async () => {
		const collection = await seedPosts();
		expect(
			(await collection.paginate({ page: 3, pageSize: 10 })).items,
		).toHaveLength(5);
		const past = await collection.paginate({ page: 4, pageSize: 10 });
		expect(past.items).toEqual([]);
		expect(past.total).toBe(25);
	});

	test('filters, sorts, and lowers a pageSize over maxPageSize', async () => {
		await seedPosts();
		const collection = getCollection(t.db, posts);
		const page = await collection.paginate({
			filter: { rank: 0 },
			sort: { title: -1 },
			pageSize: 2,
		});
		expect(page.items.map((post) => post.title)).toEqual(['p21', 'p16']);
		expect(page.total).toBe(5);
		expect(page.pageCount).toBe(3);

		const small = getCollection(t.db, posts, { maxPageSize: 7 });
		expect((await small.paginate({ pageSize: 50 })).pageSize).toBe(7);
	});

	test('an empty collection has no pages', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		expect(await collection.paginate()).toEqual({
			items: [],
			total: 0,
			page: 1,
			pageSize: 20,
			pageCount: 0,
		});
	});

	test('refuses a page that is not a positive integer', async () => {
		const collection = getCollection(t.db, posts);
		await expect(collection.paginate({ page: 0 })).rejects.toThrow(RangeError);
	});
});

describe('paginateByCursor', () => {
	test('walks _id, without repeats or gaps', async () => {
		const collection = await seedPosts();
		const pages = await walk((after) =>
			collection.paginateByCursor({ after, limit: 10 }),
		);
		expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
		expect(new Set(pages.flat()).size).toBe(25);
	});

	test('the last page has no cursor, even when it is full', async () => {
		const collection = await seedPosts();
		const pages = await walk((after) =>
			collection.paginateByCursor({ after, limit: 5 }),
		);
		expect(pages).toHaveLength(5);
	});

	test('walks a field with ties, broken by _id, both ways', async () => {
		const collection = await seedPosts();
		const up = (
			await walk((after) =>
				collection.paginateByCursor({ after, limit: 4, orderBy: 'rank' }),
			)
		).flat();
		expect(up).toHaveLength(25);
		expect(new Set(up).size).toBe(25);

		const down = (
			await walk((after) =>
				collection.paginateByCursor({
					after,
					limit: 4,
					orderBy: 'rank',
					direction: 'desc',
				}),
			)
		).flat();
		expect(down).toEqual([...up].reverse());
	});

	test('filters, and lowers a limit over maxPageSize', async () => {
		await seedPosts();
		const collection = getCollection(t.db, posts);
		const pages = await walk((after) =>
			collection.paginateByCursor({ after, limit: 2, filter: { rank: 0 } }),
		);
		expect(pages.flat()).toEqual(['p01', 'p06', 'p11', 'p16', 'p21']);

		const small = getCollection(t.db, posts, { maxPageSize: 3 });
		const page = await small.paginateByCursor({ limit: 50 });
		expect(page.items).toHaveLength(3);
		expect(page.nextCursor).not.toBeNull();
	});

	test('leaves soft-deleted documents out, unless withDeleted', async () => {
		const collection = getCollection(t.db, users);
		await collection.sync();
		const people = await collection.createMany(
			Array.from({ length: 4 }, (_, i) => ({ email: `u${i}@example.com` })),
		);
		await collection.delete(people[1]?._id as never);
		expect(
			(await collection.paginateByCursor({ limit: 10 })).items,
		).toHaveLength(3);
		expect(
			(await collection.paginateByCursor({ limit: 10, withDeleted: true }))
				.items,
		).toHaveLength(4);
	});

	test('pages along a date: its cursor keeps the Date', async () => {
		const collection = getCollection(t.db, users);
		await collection.sync();
		const base = Date.parse('2026-01-01T00:00:00.000Z');
		await collection.createMany(
			Array.from({ length: 9 }, (_, i) => ({
				email: `u${i}@example.com`,
				// Three documents share each instant, to the millisecond.
				createdAt: new Date(base + Math.floor(i / 3)),
			})),
		);
		const emails: string[] = [];
		let after: string | null = null;
		do {
			const page = await collection.paginateByCursor({
				after,
				limit: 2,
				orderBy: 'createdAt',
				direction: 'desc',
			});
			emails.push(...page.items.map((user) => user.email));
			after = page.nextCursor;
		} while (after);
		expect(emails).toHaveLength(9);
		expect(new Set(emails).size).toBe(9);
	});

	test('refuses a field that is null in a document', async () => {
		const collection = getCollection(t.db, users);
		await collection.sync();
		await collection.createMany([
			{ email: 'a@example.com', name: 'a' },
			{ email: 'b@example.com', name: 'b' },
			// MongoDB sorts null first, so a page of two ends on one.
			{ email: 'c@example.com' },
			{ email: 'd@example.com' },
		]);
		await expect(
			collection.paginateByCursor({ limit: 2, orderBy: 'name' }),
		).rejects.toThrow('"name" is null in a document of "users"');
	});

	test('refuses a forged cursor, or one for another ordering', async () => {
		const collection = await seedPosts();
		const first = await collection.paginateByCursor({ limit: 2 });
		await expect(
			collection.paginateByCursor({ after: first.nextCursor, orderBy: 'rank' }),
		).rejects.toBeInstanceOf(InvalidCursorError);
		await expect(
			collection.paginateByCursor({ after: 'garbage' }),
		).rejects.toBeInstanceOf(InvalidCursorError);
		const wrong = encodeCursor({ key: '_id:asc', values: [1, 2] });
		// It names the call, the collection and the ordering: every paginated
		// call takes the same `after`, so `expected 1 value(s), got 2` on its
		// own said which listing rejected the cursor, and along which fields,
		// not at all.
		const error = await collection.paginateByCursor({ after: wrong }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		// The same class as every other refusal of a cursor. It was a bare
		// `DataError` with `code: 'DATABASE'`, so a handler answering 400 on
		// `INVALID_CURSOR` answered 500 to a client who pasted the wrong
		// page's link.
		expect(error).toBeInstanceOf(InvalidCursorError);
		expect(error).toHaveProperty('code', 'INVALID_CURSOR');
		expect(error).toHaveProperty('collection', 'posts');
		expect((error as Error).message).toBe(
			'Invalid cursor in paginateByCursor on "posts": it holds 2 value(s) ' +
				'where the ordering _id:asc needs 1 (_id)',
		);
		await expect(
			collection.paginateByCursor({ after: 'garbage' }),
		).rejects.toThrow(
			'Invalid cursor in paginateByCursor on "posts": it cannot be decoded',
		);
	});

	test('a `limit` it will not take names the call and the collection', async () => {
		const collection = await seedPosts();
		await expect(collection.paginateByCursor({ limit: 0 })).rejects.toThrow(
			RangeError,
		);
		await expect(collection.paginateByCursor({ limit: 0 })).rejects.toThrow(
			'paginateByCursor on "posts": limit must be an integer of at least 1, not 0',
		);
		await expect(collection.paginate({ page: 0 })).rejects.toThrow(
			'paginate on "posts": page must be an integer of at least 1, not 0',
		);
		await expect(collection.paginate({ pageSize: -1 })).rejects.toThrow(
			'paginate on "posts": pageSize must be an integer of at least 1, not -1',
		);
	});

	test('refuses a field the schema does not have', async () => {
		const collection = await seedPosts();
		await expect(
			collection.paginateByCursor({ orderBy: 'nope' as never }),
		).rejects.toThrow('has no field "nope" in its schema');
	});

	test('an empty collection gives an empty page and no cursor', async () => {
		const collection = getCollection(t.db, posts);
		await collection.sync();
		expect(await collection.paginateByCursor()).toEqual({
			items: [],
			nextCursor: null,
		});
	});
});

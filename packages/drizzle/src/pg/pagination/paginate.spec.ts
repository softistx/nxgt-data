import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { asc, eq, gt } from 'drizzle-orm';
import { createTestDb } from '../../../test/db';
import { posts, teams, users } from '../../../test/schema';
import { InvalidCursorError } from '../../errors/data-error';
import { encodeCursor } from '../../pagination/cursor';
import { createRepository } from '../repository/create-repository';
import { paginate } from './paginate';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

/** 25 posts: ids 1…25, titles p01…p25, ranks 0…4 with ties. */
async function seedPosts() {
	const repo = createRepository(t.db, posts);
	await repo.createMany(
		Array.from({ length: 25 }, (_, i) => ({
			title: `p${String(i + 1).padStart(2, '0')}`,
			rank: i % 5,
		})),
	);
	return repo;
}

async function walk(
	next: (
		after: string | null,
	) => Promise<{ items: { id: number }[]; nextCursor: string | null }>,
) {
	const pages: number[][] = [];
	let after: string | null = null;
	do {
		const page = await next(after);
		pages.push(page.items.map((p) => p.id));
		after = page.nextCursor;
	} while (after);
	return pages;
}

describe('repository.paginate', () => {
	test('returns a page, the total and the page count', async () => {
		const repo = await seedPosts();
		const page = await repo.paginate({ page: 2, pageSize: 10 });
		expect(page.items.map((p) => p.id)).toEqual([
			11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
		]);
		expect(page).toMatchObject({
			total: 25,
			page: 2,
			pageSize: 10,
			pageCount: 3,
		});
	});

	test('the last page is partial, and past it is empty', async () => {
		const repo = await seedPosts();
		expect((await repo.paginate({ page: 3, pageSize: 10 })).items).toHaveLength(
			5,
		);
		const past = await repo.paginate({ page: 4, pageSize: 10 });
		expect(past.items).toEqual([]);
		expect(past.total).toBe(25);
	});

	test('filters, orders, and lowers a pageSize over maxPageSize', async () => {
		const repo = await seedPosts();
		const page = await repo.paginate({
			where: { rank: 0 },
			orderBy: { id: 'desc' },
			pageSize: 2,
		});
		expect(page.items.map((p) => p.id)).toEqual([21, 16]);
		expect(page.total).toBe(5);
		expect(page.pageCount).toBe(3);

		const small = createRepository(t.db, posts, { maxPageSize: 7 });
		expect((await small.paginate({ pageSize: 50 })).pageSize).toBe(7);
	});

	test('an empty table has no pages', async () => {
		const repo = createRepository(t.db, posts);
		expect(await repo.paginate()).toEqual({
			items: [],
			total: 0,
			page: 1,
			pageSize: 20,
			pageCount: 0,
		});
	});

	test('refuses a page that is not a positive integer', async () => {
		const repo = createRepository(t.db, posts);
		await expect(repo.paginate({ page: 0 })).rejects.toThrow(RangeError);
	});
});

describe('repository.paginateByCursor', () => {
	test('walks the primary key, without repeats or gaps', async () => {
		const repo = await seedPosts();
		const pages = await walk((after) =>
			repo.paginateByCursor({ after, limit: 10 }),
		);
		expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
		expect(pages.flat()).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
	});

	test('the last page has no cursor, even when it is full', async () => {
		const repo = await seedPosts();
		const pages = await walk((after) =>
			repo.paginateByCursor({ after, limit: 5 }),
		);
		expect(pages).toHaveLength(5);
	});

	test('walks a column with ties, broken by the primary key, both ways', async () => {
		const repo = await seedPosts();
		const up = (
			await walk((after) =>
				repo.paginateByCursor({ after, limit: 4, orderBy: 'rank' }),
			)
		).flat();
		const all = await t.db
			.select()
			.from(posts)
			.orderBy(asc(posts.rank), asc(posts.id));
		expect(up).toEqual(all.map((p) => p.id));

		const down = (
			await walk((after) =>
				repo.paginateByCursor({
					after,
					limit: 4,
					orderBy: 'rank',
					direction: 'desc',
				}),
			)
		).flat();
		expect(down).toEqual([...up].reverse());
	});

	test('filters, and leaves soft-deleted rows out', async () => {
		const repo = await seedPosts();
		const pages = await walk((after) =>
			repo.paginateByCursor({ after, limit: 2, where: gt(posts.id, 20) }),
		);
		expect(pages.flat()).toEqual([21, 22, 23, 24, 25]);

		const people = createRepository(t.db, users);
		const created = await people.createMany(
			Array.from({ length: 5 }, (_, i) => ({ email: `u${i}@example.com` })),
		);
		await people.delete(created[2]?.id as string);
		const seen = await walk(async (after) => {
			const page = await people.paginateByCursor({
				after,
				limit: 2,
				orderBy: 'email',
			});
			return {
				items: page.items.map((_user, i) => ({ id: i })),
				nextCursor: page.nextCursor,
			};
		});
		expect(seen.flat()).toHaveLength(4);
	});

	test('pages along a timestamp: its cursor keeps the Date', async () => {
		const people = createRepository(t.db, users);
		const base = Date.parse('2026-01-01T00:00:00.000Z');
		await people.createMany(
			Array.from({ length: 9 }, (_, i) => ({
				email: `u${i}@example.com`,
				// Three rows share each instant, to the millisecond.
				createdAt: new Date(base + Math.floor(i / 3) * 1),
			})),
		);
		const emails: string[] = [];
		let after: string | null = null;
		do {
			const page = await people.paginateByCursor({
				after,
				limit: 2,
				orderBy: 'createdAt',
				direction: 'desc',
			});
			emails.push(...page.items.map((u) => u.email));
			after = page.nextCursor;
		} while (after);
		expect(emails).toHaveLength(9);
		expect(new Set(emails).size).toBe(9);
	});

	test('refuses a forged cursor, or one for another ordering', async () => {
		const repo = await seedPosts();
		const first = await repo.paginateByCursor({ limit: 2 });
		await expect(
			repo.paginateByCursor({ after: first.nextCursor, orderBy: 'rank' }),
		).rejects.toBeInstanceOf(InvalidCursorError);
		await expect(
			repo.paginateByCursor({ after: 'garbage' }),
		).rejects.toBeInstanceOf(InvalidCursorError);
		const wrong = encodeCursor({ key: 'id:asc', values: [1, 2] });
		await expect(repo.paginateByCursor({ after: wrong })).rejects.toThrow(
			'expected 1 value(s), got 2',
		);
	});

	test('an empty table gives an empty page and no cursor', async () => {
		const repo = createRepository(t.db, posts);
		expect(await repo.paginateByCursor()).toEqual({
			items: [],
			nextCursor: null,
		});
	});
});

describe('paginate, on any select', () => {
	test('pages a join and counts it', async () => {
		const [core, web] = await t.db
			.insert(teams)
			.values([{ name: 'Core' }, { name: 'Web' }])
			.returning();
		await t.db.insert(users).values(
			Array.from({ length: 7 }, (_, i) => ({
				email: `u${i}@example.com`,
				teamId: i < 5 ? core?.id : web?.id,
			})),
		);
		const query = t.db
			.select({ email: users.email, team: teams.name })
			.from(users)
			.innerJoin(teams, eq(users.teamId, teams.id))
			.where(eq(teams.name, 'Core'))
			.orderBy(users.email);

		const page = await paginate(t.db, query, { page: 2, pageSize: 2 });
		expect(page.items).toEqual([
			{ email: 'u2@example.com', team: 'Core' },
			{ email: 'u3@example.com', team: 'Core' },
		]);
		expect(page).toMatchObject({
			total: 5,
			page: 2,
			pageSize: 2,
			pageCount: 3,
		});
	});

	test('takes a dynamic query', async () => {
		await seedPosts();
		const query = t.db.select().from(posts).orderBy(posts.id).$dynamic();
		const page = await paginate(t.db, query, {
			page: 3,
			pageSize: 10,
			maxPageSize: 10,
		});
		expect(page.items.map((p) => p.id)).toEqual([21, 22, 23, 24, 25]);
		expect(page.total).toBe(25);
	});
});

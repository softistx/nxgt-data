import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { asc, desc, gt, sql } from 'drizzle-orm';
import { createTestDb } from '../../../../test/db';
import { posts as postsTable, teams, users } from '../../../../test/schema';
import { ArgumentError } from '../../../errors/argument-error';
import { NotFoundError } from '../../../errors/data-error';
import { createRepository } from '../create-repository';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const repos = () => ({
	users: createRepository(t.db, users),
	teams: createRepository(t.db, teams),
	posts: createRepository(t.db, postsTable),
});

describe('reading', () => {
	test('findById and getById', async () => {
		const { users } = repos();
		const ada = await users.create({ email: 'ada@example.com' });
		expect(await users.findById(ada.id)).toEqual(ada);
		expect(await users.getById(ada.id)).toEqual(ada);
		const missing = crypto.randomUUID();
		expect(await users.findById(missing)).toBeUndefined();
		const error = await users.getById(missing).catch((e) => e);
		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.message).toBe(`No row in "users" with id ${missing}`);
		expect(error.id).toBe(missing);
		expect(error.table).toBe('users');
	});

	test('findFirst, with a where object, SQL and an ordering', async () => {
		const { posts } = repos();
		await posts.createMany([
			{ title: 'a', rank: 2 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 3 },
		]);
		expect((await posts.findFirst({ title: 'b' }))?.rank).toBe(1);
		expect(
			(
				await posts.findFirst(gt(postsTable.rank, 1), {
					orderBy: { rank: 'desc' },
				})
			)?.title,
		).toBe('c');
		expect(await posts.findFirst({ title: 'z' })).toBeUndefined();
		expect(
			(await posts.findFirst(undefined, { orderBy: asc(postsTable.rank) }))
				?.title,
		).toBe('b');
	});

	test('findMany with where, orderBy, limit and offset', async () => {
		const { posts } = repos();
		await posts.createMany(
			Array.from({ length: 5 }, (_, i) => ({ title: `p${i}`, rank: i % 2 })),
		);
		const page = await posts.findMany({
			where: { rank: 0 },
			orderBy: desc(postsTable.id),
			limit: 2,
			offset: 1,
		});
		expect(page.map((p) => p.title)).toEqual(['p2', 'p0']);
		const all = await posts.findMany({
			orderBy: [asc(postsTable.rank), desc(postsTable.id)],
		});
		expect(all.map((p) => p.title)).toEqual(['p4', 'p2', 'p0', 'p3', 'p1']);
		const byObject = await posts.findMany({
			orderBy: { rank: 'desc', title: 'asc' },
		});
		expect(byObject.map((p) => p.title)).toEqual([
			'p1',
			'p3',
			'p0',
			'p2',
			'p4',
		]);
	});

	test('count and exists', async () => {
		const { posts } = repos();
		expect(await posts.count()).toBe(0);
		expect(await posts.exists({ title: 'a' })).toBe(false);
		await posts.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
		]);
		expect(await posts.count()).toBe(2);
		expect(await posts.count({ title: 'a' })).toBe(1);
		expect(await posts.count(sql`${postsTable.rank} = 1`)).toBe(2);
		expect(await posts.exists({ title: 'a' })).toBe(true);
	});
});

describe('the where and orderBy a read is built from', () => {
	test('a where object matches null with IS NULL', async () => {
		const { users } = repos();
		await users.create({ email: 'a@example.com', name: 'A' });
		await users.create({ email: 'b@example.com' });
		const unnamed = await users.findMany({ where: { name: null } });
		expect(unnamed.map((u) => u.email)).toEqual(['b@example.com']);
	});

	test('a where object refuses undefined and unknown keys', async () => {
		const { users } = repos();
		await expect(
			users.findMany({ where: { name: undefined } }),
		).rejects.toThrow('"name" is undefined');
		await expect(
			users.findMany({ where: { nope: 1 } as unknown as { name: string } }),
		).rejects.toThrow('no column under the key "nope"');
	});

	test('refuses an orderBy, or a where, that is not one', async () => {
		const { posts } = repos();
		await expect(
			posts.findMany({ orderBy: { rank: 'down' } as never }),
		).rejects.toThrow(`orderBy: "rank" must be 'asc' or 'desc', not down`);
		await expect(
			posts.findMany({ orderBy: { nope: 'asc' } as never }),
		).rejects.toThrow('orderBy: "posts" has no column under the key "nope"');
		await expect(posts.findMany({ orderBy: 42 as never })).rejects.toThrow(
			'orderBy: expected a Drizzle ordering, a list, or an object',
		);
		await expect(posts.findMany({ where: 42 as never })).rejects.toThrow(
			'where: expected a Drizzle condition or an object',
		);
	});

	test('a refused argument is an ArgumentError, and names which one', async () => {
		const { posts } = repos();
		// A `where` or an `orderBy` built from a query string is user input, so
		// a handler answering 400 rather than 500 has to recognise these
		// without reading the message.
		const thrown = async (promise: Promise<unknown>): Promise<unknown> =>
			promise.then(
				() => {
					throw new Error('it resolved, and should not have');
				},
				(error: unknown) => error,
			);
		const bad = await thrown(
			posts.findMany({ orderBy: { rank: 'down' } as never }),
		);
		expect(bad).toBeInstanceOf(ArgumentError);
		expect(bad).toHaveProperty('code', 'INVALID_ARGUMENT');
		expect(bad).toHaveProperty('argument', 'orderBy');
		expect(bad).toHaveProperty('key', 'rank');
		// Still a TypeError, which is what it was before it had a code.
		expect(bad).toBeInstanceOf(TypeError);

		const shape = await thrown(posts.findMany({ where: 42 as never }));
		expect(shape).toHaveProperty('argument', 'where');
		expect(shape).toHaveProperty('key', undefined);
	});
});

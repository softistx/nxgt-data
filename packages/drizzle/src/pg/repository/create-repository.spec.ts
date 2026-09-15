import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { asc, desc, gt, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createTestDb } from '../../../test/db';
import {
	logs,
	memberships,
	posts as postsTable,
	teams,
	users,
} from '../../../test/schema';
import {
	ConflictError,
	ForeignKeyError,
	NotFoundError,
} from '../../errors/data-error';
import { createRepository } from './create-repository';

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

describe('create and read', () => {
	test('create returns the row, with its defaults', async () => {
		const { users } = repos();
		const ada = await users.create({ email: 'ada@example.com', name: 'Ada' });
		expect(ada.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(ada.email).toBe('ada@example.com');
		expect(ada.createdAt).toBeInstanceOf(Date);
		expect(ada.deletedAt).toBeNull();
	});

	test('createMany inserts in one go, and [] sends nothing', async () => {
		const { teams } = repos();
		const rows = await teams.createMany([{ name: 'A' }, { name: 'B' }]);
		expect(rows.map((r) => r.id)).toEqual([1, 2]);
		expect(await teams.createMany([])).toEqual([]);
		expect(await teams.count()).toBe(2);
	});

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

describe('update', () => {
	test('updates by id and returns the row', async () => {
		const { users } = repos();
		const ada = await users.create({ email: 'ada@example.com' });
		const updated = await users.update(ada.id, { name: 'Ada' });
		expect(updated.name).toBe('Ada');
		expect(updated.id).toBe(ada.id);
	});

	test('throws NotFoundError for a missing id', async () => {
		const { users } = repos();
		await expect(
			users.update(crypto.randomUUID(), { name: 'x' }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("sets updatedAt through the column's $onUpdate", async () => {
		const { users } = repos();
		const old = new Date('2000-01-01T00:00:00Z');
		const ada = await users.create({
			email: 'ada@example.com',
			updatedAt: old,
		});
		const updated = await users.update(ada.id, { name: 'Ada' });
		expect(updated.updatedAt.getTime()).toBeGreaterThan(old.getTime());
	});

	test('sets updatedAt to now() on a column without $onUpdate', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		expect(post.updatedAt).toBeNull();
		const updated = await posts.update(post.id, { title: 'b' });
		expect(updated.updatedAt).toBeInstanceOf(Date);
	});

	test('keeps an updatedAt the patch sets, and touches nothing with touchUpdatedAt: false', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		const at = new Date('2001-02-03T04:05:06.789Z');
		expect((await posts.update(post.id, { updatedAt: at })).updatedAt).toEqual(
			at,
		);
		const untouched = createRepository(t.db, postsTable, {
			touchUpdatedAt: false,
		});
		const other = await untouched.create({ title: 'b', rank: 1 });
		expect(
			(await untouched.update(other.id, { title: 'c' })).updatedAt,
		).toBeNull();
	});

	test('an empty patch reads the row back', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		expect(await posts.update(post.id, {})).toEqual(post);
		expect(await posts.update(post.id, { title: undefined })).toEqual(post);
		await expect(posts.update(999, {})).rejects.toBeInstanceOf(NotFoundError);
	});

	test('takes SQL values', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		const updated = await posts.update(post.id, {
			rank: sql`${postsTable.rank} + 10`,
		});
		expect(updated.rank).toBe(11);
	});

	test('updateMany updates what matches and needs a where', async () => {
		const { posts } = repos();
		await posts.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 1 },
			{ title: 'c', rank: 2 },
		]);
		const updated = await posts.updateMany({ rank: 1 }, { title: 'x' });
		expect(updated).toHaveLength(2);
		expect(await posts.count({ title: 'x' })).toBe(2);
		await expect(posts.updateMany(undefined, { title: 'y' })).rejects.toThrow(
			'updateMany needs a where',
		);
		await expect(posts.updateMany({}, { title: 'y' })).rejects.toThrow(
			TypeError,
		);
		expect(await posts.updateMany(sql`true`, { rank: 5 })).toHaveLength(3);
		expect(await posts.updateMany({ rank: 5 }, {})).toHaveLength(3);
	});
});

describe('delete, on a table without soft delete', () => {
	test('delete removes the row and returns it', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		expect(await posts.delete(post.id)).toEqual(post);
		expect(await posts.count()).toBe(0);
		await expect(posts.delete(post.id)).rejects.toBeInstanceOf(NotFoundError);
	});

	test('deleteMany removes what matches and needs a where', async () => {
		const { posts } = repos();
		await posts.createMany([
			{ title: 'a', rank: 1 },
			{ title: 'b', rank: 2 },
		]);
		expect(await posts.deleteMany({ rank: 1 })).toHaveLength(1);
		await expect(posts.deleteMany({})).rejects.toThrow(
			'deleteMany needs a where',
		);
		expect(await posts.count()).toBe(1);
	});

	test('restore throws on a table without soft delete', async () => {
		const plain = createRepository(t.db, postsTable) as unknown as {
			restore(id: number): Promise<unknown>;
		};
		await expect(plain.restore(1)).rejects.toThrow('has no soft delete');
	});
});

describe('database errors', () => {
	test('a duplicate is a ConflictError', async () => {
		const { users } = repos();
		await users.create({ email: 'ada@example.com' });
		const error = await users
			.create({ email: 'ada@example.com' })
			.catch((e) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.columns).toEqual(['email']);
	});

	test('a missing parent is a ForeignKeyError, from update too', async () => {
		const { users } = repos();
		const ada = await users.create({ email: 'ada@example.com' });
		await expect(users.update(ada.id, { teamId: 42 })).rejects.toBeInstanceOf(
			ForeignKeyError,
		);
	});
});

describe('primary keys', () => {
	test('a composite primary key refuses the methods by id, with a clear error', async () => {
		const members = createRepository(t.db, memberships);
		const userId = crypto.randomUUID();
		await members.create({ userId, teamId: 1, role: 'owner' });
		expect(await members.findMany({ where: { userId } })).toHaveLength(1);
		await expect(
			(members.findById as (id: unknown) => Promise<unknown>)(userId),
		).rejects.toThrow('composite primary key (user_id, team_id)');
	});

	test('a table without a primary key refuses them too', async () => {
		const repo = createRepository(t.db, logs);
		await repo.create({ message: 'hi' });
		expect(await repo.count()).toBe(1);
		await expect(
			(repo.delete as (id: unknown) => Promise<unknown>)('hi'),
		).rejects.toThrow('has no primary key');
	});

	test('a primary key under another key than id asks for primaryKey', async () => {
		const tags = pgTable('tags', { slug: text('slug').primaryKey() });
		const repo = createRepository(t.db, tags);
		await expect(
			(repo.findById as (id: unknown) => Promise<unknown>)('x'),
		).rejects.toThrow(`Pass \`primaryKey: 'slug'\` to createRepository`);
	});

	test('primaryKey names the column to look rows up by', async () => {
		const byEmail = createRepository(t.db, users, { primaryKey: 'email' });
		await byEmail.create({ email: 'ada@example.com' });
		expect((await byEmail.getById('ada@example.com')).email).toBe(
			'ada@example.com',
		);
		const updated = await byEmail.update('ada@example.com', { name: 'Ada' });
		expect(updated.name).toBe('Ada');
	});

	test('an unknown primaryKey throws at creation', () => {
		expect(() =>
			createRepository(t.db, users, { primaryKey: 'nope' as 'email' }),
		).toThrow('"users" has no column under the key "nope"');
	});
});

describe('with', () => {
	test('binds the same repository to another database or transaction', async () => {
		const { teams } = repos();
		await t.db
			.transaction(async (tx) => {
				await teams.with(tx).create({ name: 'Inside' });
				expect(await teams.with(tx).count()).toBe(1);
				tx.rollback();
			})
			.catch(() => {});
		expect(await teams.count()).toBe(0);
	});
});

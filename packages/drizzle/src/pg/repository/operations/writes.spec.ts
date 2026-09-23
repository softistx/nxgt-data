import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../../../../test/db';
import { rejection } from '../../../../test/rejection';
import {
	memberships,
	posts as postsTable,
	teams,
	tickets,
	users,
} from '../../../../test/schema';
import { ArgumentError } from '../../../errors/argument-error';
import {
	ConflictError,
	ForeignKeyError,
	InvalidValueError,
	NotFoundError,
} from '../../../errors/data-error';
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

describe('creating', () => {
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
		// An empty `where` is the caller's argument, so it is an `ArgumentError`
		// naming it — and still a `TypeError`, which is what it threw before.
		const refused = await posts
			.updateMany({}, { title: 'y' })
			.then(null, (error: unknown) => error);
		expect(refused).toBeInstanceOf(ArgumentError);
		expect(refused).toHaveProperty('code', 'INVALID_ARGUMENT');
		expect(refused).toHaveProperty('argument', 'where');
		expect(await posts.updateMany(sql`true`, { rank: 5 })).toHaveLength(3);
		expect(await posts.updateMany({ rank: 5 }, {})).toHaveLength(3);
	});
});

describe('the primary key', () => {
	const moving = (key: string) =>
		`"${key}" is a primary-key column, which an update never moves. Leave it out; a row that needs another key is a new row`;

	async function refused(write: Promise<unknown>, message: string) {
		const error = await rejection(write);
		expect(error).toBeInstanceOf(ArgumentError);
		expect(error).toHaveProperty('argument', 'patch');
		expect((error as Error).message).toBe(message);
		return error;
	}

	test('update and updateMany refuse a patch that names it, value or SQL, and write nothing', async () => {
		const { users, teams } = repos();
		const ada = await users.create({ email: 'ada@example.com' });
		const other = crypto.randomUUID();
		const error = await refused(
			users.update(ada.id, { id: other, name: 'Ada' } as never),
			`update on "users": ${moving('id')}`,
		);
		expect(error).toHaveProperty('key', 'id');
		expect((error as Error).message).not.toContain(other);
		const team = await teams.create({ name: 'A' });
		await refused(
			teams.update(team.id, { id: sql`${teams.table.id} + 1` } as never),
			`update on "teams": ${moving('id')}`,
		);
		await refused(
			teams.updateMany({ name: 'A' }, { id: 2 } as never),
			`updateMany on "teams": ${moving('id')}`,
		);
		expect(await users.findMany()).toEqual([ada]);
		expect(await teams.findMany()).toEqual([team]);
	});

	test('an undefined key writes nothing, as any undefined value does', async () => {
		const { posts } = repos();
		const post = await posts.create({ title: 'a', rank: 1 });
		const updated = await posts.update(post.id, { id: undefined, title: 'b' });
		expect(updated).toMatchObject({ id: post.id, title: 'b' });
	});

	test('a repository that locks refuses it with a version too', async () => {
		const repo = createRepository(t.db, tickets);
		const row = await repo.create({ slug: 'a', title: 'A' });
		await refused(
			repo.update(row.id, { id: crypto.randomUUID(), version: 0 } as never),
			`update on "tickets": ${moving('id')}`,
		);
		expect((await repo.getById(row.id)).version).toBe(0);
	});

	test('every column of a composite key is refused, and the key a repository is given', async () => {
		const members = createRepository(t.db, memberships);
		const row = await members.create({
			userId: crypto.randomUUID(),
			teamId: 1,
			role: 'owner',
		});
		for (const patch of [{ userId: crypto.randomUUID() }, { teamId: 2 }]) {
			const [key] = Object.keys(patch) as [string];
			await refused(
				members.updateMany({ role: 'owner' }, patch),
				`updateMany on "memberships": ${moving(key)}`,
			);
		}
		const byRole = createRepository(t.db, memberships, { primaryKey: 'role' });
		await refused(
			byRole.update('owner', { role: 'admin' } as never),
			`update on "memberships": ${moving('role')}`,
		);
		await refused(
			byRole.update('owner', { teamId: 2 }),
			`update on "memberships": ${moving('teamId')}`,
		);
		expect(await members.findMany()).toEqual([row]);
		// A column outside the key is written as ever.
		expect(
			await members.updateMany({ role: 'owner' }, { role: 'admin' }),
		).toEqual([{ ...row, role: 'admin' }]);
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

	test("an id the column's type refuses is an InvalidValueError", async () => {
		const { users } = repos();
		// A URL parameter a client mistyped, handed straight to `findById`.
		// It used to come back `code: 'DATABASE'` — the same answer as a
		// database that is down, so a handler that maps codes to statuses
		// answered 500 to what is a 400.
		const error = await users.findById('nope' as never).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(InvalidValueError);
		expect(error).toHaveProperty('code', 'INVALID_VALUE');
		expect(error).toHaveProperty('sqlState', '22P02');
		expect((error as Error).message).toBe(
			'invalid input syntax for type uuid: "nope"',
		);
	});
});

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { createTestDb } from '../../../test/db';
import {
	logs,
	memberships,
	posts as postsTable,
	teams,
	users,
} from '../../../test/schema';
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

	test('keeps the options it was created with', async () => {
		const byEmail = createRepository(t.db, users, {
			primaryKey: 'email',
			maxPageSize: 1,
		});
		await byEmail.create({ email: 'ada@example.com' });
		const bound = byEmail.with(t.db);
		expect((await bound.getById('ada@example.com')).name).toBeNull();
		expect((await bound.paginate({ pageSize: 10 })).pageSize).toBe(1);
	});
});

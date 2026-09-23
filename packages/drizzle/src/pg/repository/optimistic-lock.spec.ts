import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createTestDb } from '../../../test/db';
import { rejection } from '../../../test/rejection';
import { posts, tickets } from '../../../test/schema';
import { ArgumentError } from '../../errors/argument-error';
import { NotFoundError, OptimisticLockError } from '../../errors/data-error';
import { createRepository } from './create-repository';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const seed = async () => {
	const repo = createRepository(t.db, tickets);
	const ticket = await repo.create({ slug: 'a', title: 'A' });
	return { repo, ticket };
};

describe('optimistic locking', () => {
	test('every update raises the version', async () => {
		const { repo, ticket } = await seed();
		expect(ticket.version).toBe(0);
		expect((await repo.update(ticket.id, { title: 'B' })).version).toBe(1);
		expect((await repo.updateMany({ slug: 'a' }, { title: 'C' }))[0]).toEqual(
			expect.objectContaining({ version: 2 }),
		);
		expect((await repo.delete(ticket.id)).version).toBe(3);
		expect((await repo.restore(ticket.id)).version).toBe(4);
		expect((await repo.deleteMany({ slug: 'a' }))[0]?.version).toBe(5);
	});

	test('an empty patch raises nothing', async () => {
		const { repo, ticket } = await seed();
		expect(await repo.update(ticket.id, {})).toEqual(ticket);
	});

	test('a version in the patch writes only while it still matches', async () => {
		const { repo, ticket } = await seed();
		const updated = await repo.update(ticket.id, { title: 'B', version: 0 });
		expect(updated.version).toBe(1);

		const error = await rejection(
			repo.update(ticket.id, { title: 'Stale', version: 0 }),
		);
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect(error).toMatchObject({
			code: 'OPTIMISTIC_LOCK',
			table: 'tickets',
			id: ticket.id,
			expectedVersion: 0,
			actualVersion: 1,
		});
		expect((error as Error).message).toBe(
			'update on "tickets": the row is no longer at the version the patch expected: it changed since it was read',
		);
		expect((await repo.getById(ticket.id)).title).toBe('B');
	});

	test('the second of two readers loses, and nothing is lost silently', async () => {
		const { repo, ticket } = await seed();
		const first = await repo.getById(ticket.id);
		const second = await repo.getById(ticket.id);
		await repo.update(first.id, { title: 'First', version: first.version });
		const error = await rejection(
			repo.update(second.id, { title: 'Second', version: second.version }),
		);
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect((await repo.getById(ticket.id)).title).toBe('First');
	});

	test('a version alone is checked, and writes nothing', async () => {
		const { repo, ticket } = await seed();
		expect(await repo.update(ticket.id, { version: 0 })).toEqual(ticket);
		await repo.update(ticket.id, { title: 'B' });
		const error = await rejection(repo.update(ticket.id, { version: 0 }));
		expect(error).toBeInstanceOf(OptimisticLockError);
		expect(error).toHaveProperty('actualVersion', 1);
	});

	test('a missing or soft-deleted row is a NotFoundError, not a lock failure', async () => {
		const { repo, ticket } = await seed();
		const missing = await rejection(
			repo.update(crypto.randomUUID(), { title: 'x', version: 0 }),
		);
		expect(missing).toBeInstanceOf(NotFoundError);
		await repo.delete(ticket.id);
		const deleted = await rejection(
			repo.update(ticket.id, { title: 'x', version: 1 }),
		);
		expect(deleted).toBeInstanceOf(NotFoundError);
	});

	test('a version that is not a whole number is an ArgumentError naming its shape', async () => {
		const { repo, ticket } = await seed();
		for (const [given, shape] of [
			['3', 'a string'],
			[1.5, 'a fraction'],
			[-1, 'a negative number'],
			[sql`1`, 'SQL'],
		] as const) {
			const error = await rejection(
				repo.update(ticket.id, { title: 'x', version: given as never }),
			);
			expect(error).toBeInstanceOf(ArgumentError);
			expect(error).toMatchObject({ argument: 'patch', key: 'version' });
			expect((error as Error).message).toBe(
				`update on "tickets": the expected "version" must be a whole number, not ${shape}`,
			);
		}
	});

	test('updateMany refuses a version: one cannot stand for many rows', async () => {
		const { repo } = await seed();
		const error = await rejection(
			repo.updateMany({ slug: 'a' }, { version: 0 } as never),
		);
		expect(error).toBeInstanceOf(ArgumentError);
		expect((error as Error).message).toBe(
			'updateMany on "tickets": "version" is the optimistic lock, which only update checks. Leave it out; every write raises it',
		);
	});

	test('create keeps a version it is given: an import keeps its number', async () => {
		const repo = createRepository(t.db, tickets);
		expect(
			(await repo.create({ slug: 'b', title: 'B', version: 7 })).version,
		).toBe(7);
	});

	test('optimisticLock: false makes version an ordinary column', async () => {
		const plain = createRepository(t.db, tickets, { optimisticLock: false });
		const ticket = await plain.create({ slug: 'a', title: 'A' });
		expect((await plain.update(ticket.id, { title: 'B' })).version).toBe(0);
		expect((await plain.update(ticket.id, { version: 9 })).version).toBe(9);
	});

	test('a table without an integer NOT NULL version does not lock', async () => {
		const drafts = pgTable('posts', {
			id: integer('id').primaryKey(),
			title: text('title').notNull(),
			version: text('rank'),
		});
		expect(() =>
			createRepository(t.db, drafts, { optimisticLock: true as never }),
		).toThrow(
			`createRepository: optimisticLock needs an integer NOT NULL "version" column, and "posts"'s is not one`,
		);
		expect(() =>
			createRepository(t.db, posts, { optimisticLock: true as never }),
		).toThrow(
			'createRepository: optimisticLock needs a "version" column, and "posts" has none',
		);
		const repo = createRepository(t.db, posts);
		const post = await repo.create({ title: 'a', rank: 1 });
		expect(await repo.update(post.id, { title: 'b' })).toHaveProperty(
			'title',
			'b',
		);
	});
});

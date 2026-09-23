import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createTestDb } from '../../../../test/db';
import { rejection } from '../../../../test/rejection';
import { posts, teams, tickets, users } from '../../../../test/schema';
import { ArgumentError } from '../../../errors/argument-error';
import {
	ConflictError,
	DataError,
	NotNullViolationError,
} from '../../../errors/data-error';
import { createRepository } from '../create-repository';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

/** A unique key, and an `updatedAt` without `$onUpdate`: this file's own. */
const labels = pgTable('labels', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	name: text('name').notNull(),
	color: text('color'),
	updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }),
});

/** A lock with no default: the insert half has to seed it. */
const counters = pgTable('counters', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	name: text('name').notNull(),
	hits: integer('hits'),
	version: integer('version').notNull(),
});

const ada = crypto.randomUUID();
const grace = crypto.randomUUID();

describe('upsert', () => {
	test('inserts the row the where identifies, then updates it', async () => {
		const repo = createRepository(t.db, users);
		const created = await repo.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada' },
		);
		expect(created).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
		const updated = await repo.upsert(
			{ email: 'ada@example.com' },
			{ name: 'Ada L.', age: 36 },
		);
		expect(updated.id).toBe(created.id);
		expect(updated).toMatchObject({ name: 'Ada L.', age: 36 });
		expect(updated.createdAt).toEqual(created.createdAt);
		expect(await repo.count()).toBe(1);
	});

	// PGlite has one connection, so these queue rather than race: it pins the
	// statement's shape, and the race itself is PostgreSQL's ON CONFLICT.
	test('calls on one key leave one row', async () => {
		const repo = createRepository(t.db, teams);
		const rows = await Promise.all(
			['a', 'b', 'c'].map(() => repo.upsert({ name: 'Core' }, {})),
		);
		expect(new Set(rows.map((row) => row.id)).size).toBe(1);
		expect(await repo.count()).toBe(1);
	});

	test('the update half keeps the stamps: version, updatedBy, never createdBy', async () => {
		const repo = createRepository(t.db, tickets);
		const first = await repo.as(ada).upsert({ slug: 'a' }, { title: 'A' });
		expect(first).toMatchObject({
			version: 0,
			createdBy: ada,
			updatedBy: ada,
		});
		const second = await repo
			.as(grace)
			.upsert({ slug: 'a' }, { title: 'B', createdBy: grace });
		expect(second).toMatchObject({
			title: 'B',
			version: 1,
			createdBy: ada,
			updatedBy: grace,
		});
		expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
			first.updatedAt.getTime(),
		);
	});

	test('sets updatedAt on a column without $onUpdate, and nothing to write leaves it', async () => {
		await t.client.exec(`
			create table if not exists labels (
				id integer primary key generated always as identity,
				name text not null constraint labels_name_unique unique,
				color text,
				updated_at timestamptz(3)
			);
			truncate labels;
		`);
		const repo = createRepository(t.db, labels);
		const first = await repo.upsert({ name: 'bug' }, { color: 'red' });
		expect(first.updatedAt).toBeNull();
		expect(await repo.upsert({ name: 'bug' }, {})).toEqual(first);
		const second = await repo.upsert({ name: 'bug' }, { color: 'blue' });
		expect(second.updatedAt).toBeInstanceOf(Date);
	});

	test('a required column is named on every call, even when the row is there', async () => {
		// PostgreSQL checks the row it would insert before it looks for a
		// conflict, so a NOT NULL column without a default is required either
		// way — which is why the types require it.
		const repo = createRepository(t.db, tickets);
		await repo.upsert({ slug: 'a' }, { title: 'A' });
		const error = await rejection(repo.upsert({ slug: 'a' }, {} as never));
		expect(error).toBeInstanceOf(NotNullViolationError);
		expect((await repo.findFirst({ slug: 'a' }))?.version).toBe(0);
	});

	test('an id in the values is chosen on insert, and never moves a row that is there', async () => {
		const repo = createRepository(t.db, tickets);
		const chosen = crypto.randomUUID();
		const first = await repo.upsert({ slug: 'a' }, { title: 'A', id: chosen });
		expect(first.id).toBe(chosen);
		const second = await repo.upsert(
			{ slug: 'a' },
			{ title: 'B', id: crypto.randomUUID() },
		);
		expect(second).toMatchObject({ id: chosen, title: 'B' });
	});

	test('nothing to write leaves an $onUpdate column as it was', async () => {
		const repo = createRepository(t.db, users);
		const first = await repo.upsert({ email: 'ada@example.com' }, {});
		const again = await repo.upsert({ email: 'ada@example.com' }, {});
		expect(again).toEqual(first);
	});

	test('a lock with no default starts at 0, for a new key and a row that is there', async () => {
		await t.client.exec(`
			create table if not exists counters (
				id integer primary key generated always as identity,
				name text not null constraint counters_name_unique unique,
				hits integer,
				version integer not null
			);
			truncate counters;
		`);
		const repo = createRepository(t.db, counters);
		const first = await repo.upsert({ name: 'home' }, { hits: 1 });
		expect(first).toMatchObject({ hits: 1, version: 0 });
		const second = await repo.upsert({ name: 'home' }, { hits: 2 });
		expect(second).toMatchObject({ id: first.id, hits: 2, version: 1 });
		expect(await repo.upsert({ name: 'home' }, {})).toEqual(second);
	});

	test('takes SQL in the values', async () => {
		const repo = createRepository(t.db, users);
		const row = await repo.upsert(
			{ email: 'ada@example.com' },
			{ name: sql`upper('ada')` },
		);
		expect(row.name).toBe('ADA');
	});

	test('a soft-deleted row is not written over: a ConflictError says so', async () => {
		const repo = createRepository(t.db, tickets);
		const ticket = await repo.create({ slug: 'a', title: 'A' });
		await repo.delete(ticket.id);
		const error = await rejection(repo.upsert({ slug: 'a' }, { title: 'B' }));
		expect(error).toBeInstanceOf(ConflictError);
		expect(error).toMatchObject({ table: 'tickets', columns: ['slug'] });
		expect((error as Error).message).toBe(
			'upsert on "tickets": the row with this (slug) is soft-deleted. Restore it, or hard-delete it, before writing over its key',
		);
		const kept = await repo.findById(ticket.id, { withDeleted: true });
		expect(kept?.title).toBe('A');
	});

	test('a where no unique constraint covers is a DataError naming the columns', async () => {
		const repo = createRepository(t.db, posts);
		const error = await rejection(repo.upsert({ title: 'a' }, { rank: 1 }));
		expect(error).toBeInstanceOf(DataError);
		expect(error).toMatchObject({
			code: 'DATABASE',
			sqlState: '42P10',
			table: 'posts',
			columns: ['title'],
		});
		expect((error as Error).message).toBe(
			`upsert on "posts": no unique constraint covers exactly (title), the where's columns. Add one, or name the columns one covers`,
		);
	});

	test('refuses a where that cannot be inserted, before anything is sent', async () => {
		const repo = createRepository(t.db, tickets);
		const cases: [unknown, string][] = [
			[sql`true`, 'the where must be an object of column values, not SQL'],
			[{}, 'the where is empty. Name the columns a unique constraint covers'],
			[{ nope: 1 }, 'the where names "nope", which is no column of the table'],
			[
				{ slug: null },
				'"slug" in the where is null. It is inserted as well as matched, so it must be a value, and NULL never conflicts',
			],
			[
				{ slug: sql`'a'` },
				'"slug" in the where is SQL. It is inserted as well as matched, so it must be a value, and NULL never conflicts',
			],
			[
				{ version: 0 },
				'"version" is the optimistic lock, which the repository keeps. Leave it out',
			],
		];
		for (const [where, message] of cases) {
			const error = await rejection(
				repo.upsert(where as never, { title: 'A' } as never),
			);
			expect(error).toBeInstanceOf(ArgumentError);
			expect(error).toHaveProperty('argument', 'where');
			expect((error as Error).message).toBe(`upsert on "tickets": ${message}`);
		}
		expect(await repo.count(undefined, { withDeleted: true })).toBe(0);
	});

	test('refuses values that repeat the where, or give a version', async () => {
		const repo = createRepository(t.db, tickets);
		const cases: [unknown, string][] = [
			[[], 'the values must be an object, not an array'],
			[
				{ slug: 'b', title: 'A' },
				'"slug" is in both the where and the values. Name it in the where alone',
			],
			[
				{ title: 'A', version: 0 },
				'"version" is the optimistic lock, which only update checks. Leave it out; every write raises it',
			],
		];
		for (const [values, message] of cases) {
			const error = await rejection(
				repo.upsert({ slug: 'a' }, values as never),
			);
			expect(error).toBeInstanceOf(ArgumentError);
			expect(error).toHaveProperty('argument', 'values');
			expect((error as Error).message).toBe(`upsert on "tickets": ${message}`);
		}
	});
});

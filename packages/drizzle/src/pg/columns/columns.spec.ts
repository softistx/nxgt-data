import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { createTestDb } from '../../../test/db';
import { teams, users } from '../../../test/schema';
import { actors, id, softDelete, timestamps, version } from './columns';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const sqlTypes = (table: Parameters<typeof getTableConfig>[0]) =>
	Object.fromEntries(
		getTableConfig(table).columns.map((c) => [
			c.name,
			{
				type: c.getSQLType(),
				notNull: c.notNull,
				primary: c.primary,
				hasDefault: c.hasDefault,
			},
		]),
	);

describe('the column helpers', () => {
	test('declare what their DDL says', () => {
		const table = pgTable('things', {
			id: id(),
			name: text('name'),
			...timestamps(),
			...softDelete(),
		});
		expect(sqlTypes(table)).toEqual({
			id: { type: 'uuid', notNull: true, primary: true, hasDefault: true },
			name: { type: 'text', notNull: false, primary: false, hasDefault: false },
			created_at: {
				type: 'timestamp (3) with time zone',
				notNull: true,
				primary: false,
				hasDefault: true,
			},
			updated_at: {
				type: 'timestamp (3) with time zone',
				notNull: true,
				primary: false,
				hasDefault: true,
			},
			deleted_at: {
				type: 'timestamp (3) with time zone',
				notNull: false,
				primary: false,
				hasDefault: false,
			},
		});
		expect(sqlTypes(pgTable('counted', { id: id('identity') }))).toEqual({
			id: { type: 'integer', notNull: true, primary: true, hasDefault: true },
		});
	});

	test('version and actors declare what their DDL says', () => {
		const table = pgTable('stamped', { ...version(), ...actors() });
		const nullable = (type: string) => ({
			type,
			notNull: false,
			primary: false,
			hasDefault: false,
		});
		expect(sqlTypes(table)).toEqual({
			version: {
				type: 'integer',
				notNull: true,
				primary: false,
				hasDefault: true,
			},
			created_by: nullable('uuid'),
			updated_by: nullable('uuid'),
			deleted_by: nullable('uuid'),
		});
		expect(sqlTypes(pgTable('by_text', actors('text'))).created_by?.type).toBe(
			'text',
		);
		expect(
			sqlTypes(pgTable('by_int', actors('integer'))).deleted_by?.type,
		).toBe('integer');
	});

	test('give fresh builders on every call', () => {
		expect(timestamps().createdAt).not.toBe(timestamps().createdAt);
		expect(id()).not.toBe(id());
	});

	test('fill their defaults on insert', async () => {
		const [user] = await t.db
			.insert(users)
			.values({ email: 'a@example.com' })
			.returning();
		expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(user?.createdAt).toBeInstanceOf(Date);
		expect(user?.updatedAt).toBeInstanceOf(Date);
		expect(user?.deletedAt).toBeNull();
		const [team] = await t.db
			.insert(teams)
			.values({ name: 'Core' })
			.returning();
		expect(team?.id).toBe(1);
	});

	test('keep milliseconds exactly', async () => {
		const at = new Date('2026-09-15T12:34:56.789Z');
		const [user] = await t.db
			.insert(users)
			.values({ email: 'a@example.com', createdAt: at })
			.returning();
		expect(user?.createdAt.toISOString()).toBe(at.toISOString());
	});
});

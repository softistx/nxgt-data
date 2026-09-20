import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { createTestDb } from '../../test/db';
import { memberships, teams, users } from '../../test/schema';
import {
	CheckViolationError,
	ConflictError,
	DataError,
	ForeignKeyError,
	InvalidValueError,
	NotFoundError,
	NotNullViolationError,
} from './data-error';
import { toDataError } from './to-data-error';

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
	t = await createTestDb();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

async function caught(promise: PromiseLike<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected the query to fail');
}

describe('toDataError, from real PostgreSQL errors', () => {
	test('a unique violation is a ConflictError, with its constraint and columns', async () => {
		await t.db.insert(users).values({ email: 'ada@example.com' });
		const raw = await caught(
			t.db.insert(users).values({ email: 'ada@example.com' }),
		);
		expect(raw).toBeInstanceOf(DrizzleQueryError);

		const error = toDataError(raw);
		expect(error).toBeInstanceOf(ConflictError);
		expect(error).toBeInstanceOf(DataError);
		const conflict = error as ConflictError;
		expect(conflict.code).toBe('CONFLICT');
		expect(conflict.sqlState).toBe('23505');
		expect(conflict.constraint).toBe('users_email_unique');
		expect(conflict.table).toBe('users');
		expect(conflict.columns).toEqual(['email']);
		expect(conflict.detail).toContain('already exists');
		expect(conflict.cause).toBe(raw);
		expect(conflict.message).toBe(
			'Unique constraint "users_email_unique" violated on "users"',
		);
		expect(conflict.name).toBe('ConflictError');
	});

	test('a unique violation over two columns names both', async () => {
		await t.db.insert(memberships).values({
			userId: crypto.randomUUID(),
			teamId: 1,
			role: 'owner',
		});
		const error = toDataError(
			await caught(
				t.db.insert(memberships).values({
					userId: crypto.randomUUID(),
					teamId: 1,
					role: 'owner',
				}),
			),
		) as ConflictError;
		expect(error.constraint).toBe('memberships_role_unique');
		expect(error.columns).toEqual(['team_id', 'role']);
	});

	test('a missing parent is a ForeignKeyError', async () => {
		const error = toDataError(
			await caught(
				t.db.insert(users).values({ email: 'a@example.com', teamId: 99 }),
			),
		) as ForeignKeyError;
		expect(error).toBeInstanceOf(ForeignKeyError);
		expect(error.code).toBe('FOREIGN_KEY');
		expect(error.sqlState).toBe('23503');
		expect(error.constraint).toBe('users_team_fk');
		expect(error.columns).toEqual(['team_id']);
	});

	test('deleting a parent still referenced is a ForeignKeyError', async () => {
		const [team] = await t.db
			.insert(teams)
			.values({ name: 'Core' })
			.returning();
		await t.db
			.insert(users)
			.values({ email: 'a@example.com', teamId: team?.id });
		const error = toDataError(await caught(t.db.delete(teams)));
		expect(error).toBeInstanceOf(ForeignKeyError);
		expect((error as ForeignKeyError).detail).toContain('still referenced');
	});

	test('a check violation is a CheckViolationError', async () => {
		const error = toDataError(
			await caught(
				t.db.insert(users).values({ email: 'a@example.com', age: -1 }),
			),
		) as CheckViolationError;
		expect(error).toBeInstanceOf(CheckViolationError);
		expect(error.code).toBe('CHECK_VIOLATION');
		expect(error.constraint).toBe('users_age_check');
		expect(error.table).toBe('users');
	});

	test('a null in a NOT NULL column is a NotNullViolationError, with the column', async () => {
		const error = toDataError(
			await caught(t.db.execute(sql`insert into users (email) values (null)`)),
		) as NotNullViolationError;
		expect(error).toBeInstanceOf(NotNullViolationError);
		expect(error.code).toBe('NOT_NULL_VIOLATION');
		expect(error.columns).toEqual(['email']);
		expect(error.message).toBe('Column "email" on "users" cannot be null');
	});

	test('any other database error is a DataError with its SQLSTATE', async () => {
		const raw = await caught(t.db.execute(sql`select * from nowhere`));
		const error = toDataError(raw) as DataError;
		expect(error.constructor).toBe(DataError);
		expect(error.code).toBe('DATABASE');
		expect(error.sqlState).toBe('42P01');
		expect(error.message).toContain('nowhere');
		expect(error.cause).toBe(raw);
	});
});

describe("a value the column's type refuses", () => {
	/**
	 * The five SQLSTATEs of the `22` class this package answers with a 400,
	 * each measured against PGlite 0.5.8 rather than taken from the standard.
	 */
	const REFUSED: [string, string, () => PromiseLike<unknown>][] = [
		[
			'22P02',
			'text where a uuid goes',
			() => t.db.execute(sql`select * from users where id = 'abc'`),
		],
		[
			'22001',
			'longer than the column',
			// An insert, not a cast: measured, `'abcdef'::varchar(3)` truncates
			// and succeeds — PostgreSQL only refuses the length when the value
			// is *assigned* to a column.
			async () => {
				await t.db.execute(
					sql`create temp table if not exists nxgt_short (s varchar(3))`,
				);
				return t.db.execute(sql`insert into nxgt_short (s) values ('abcdef')`);
			},
		],
		[
			'22003',
			"out of the type's range",
			() => t.db.execute(sql`select 2147483648::integer`),
		],
		[
			'22007',
			'text where a date goes',
			() => t.db.execute(sql`select 'not-a-date'::date`),
		],
		[
			'22008',
			'a date that is not one',
			() => t.db.execute(sql`select '2026-13-45'::timestamptz`),
		],
	];

	for (const [sqlState, what, run] of REFUSED) {
		test(`${sqlState}, ${what}, is an InvalidValueError`, async () => {
			const error = toDataError(await caught(run()));
			expect(error).toBeInstanceOf(InvalidValueError);
			expect(error).toBeInstanceOf(DataError);
			expect(error).toHaveProperty('code', 'INVALID_VALUE');
			expect(error).toHaveProperty('sqlState', sqlState);
			// Measured: this family carries no table, no column and no detail,
			// so the database's own sentence is all there is to report.
			expect(error).toHaveProperty('table', undefined);
			expect(error).toHaveProperty('detail', undefined);
			expect((error as DataError).columns).toEqual([]);
			expect((error as Error).message).not.toBe('');
		});
	}

	test('a division by zero is not one of them', async () => {
		// The query, not a value handed to it: a 500, and a `DataError` with
		// its SQLSTATE, the way every other server error is.
		const error = toDataError(await caught(t.db.execute(sql`select 1 / 0`)));
		expect(error).not.toBeInstanceOf(InvalidValueError);
		expect(error).toBeInstanceOf(DataError);
		expect(error).toHaveProperty('code', 'DATABASE');
		expect(error).toHaveProperty('sqlState', '22012');
	});
});

describe('toDataError, on anything else', () => {
	test('an error without a SQLSTATE is returned as it is', () => {
		const error = new TypeError('nope');
		expect(toDataError(error)).toBe(error);
		expect(toDataError('text')).toBe('text');
		expect(toDataError(undefined)).toBeUndefined();
	});

	test('a DataError is returned as it is', () => {
		const error = new NotFoundError('gone');
		expect(toDataError(error)).toBe(error);
	});

	test('a code that is not a SQLSTATE is not one', () => {
		const error = Object.assign(new Error('fs'), { code: 'ENOENT' });
		expect(toDataError(error)).toBe(error);
	});

	test('reads postgres.js field names, deep in the cause chain', () => {
		const driver = {
			code: '23505',
			message: 'duplicate key',
			constraint_name: 'orders_ref_unique',
			table_name: 'orders',
			detail: 'Key ("ref")=(A-1) already exists.',
		};
		const wrapped = new Error('outer', {
			cause: new Error('middle', { cause: driver }),
		});
		const error = toDataError(wrapped) as ConflictError;
		expect(error).toBeInstanceOf(ConflictError);
		expect(error.constraint).toBe('orders_ref_unique');
		expect(error.table).toBe('orders');
		expect(error.columns).toEqual(['ref']);
	});
});

describe('the errors', () => {
	test('can be thrown by an application, with defaults', () => {
		const error = new NotFoundError(undefined, { table: 'users', id: 7 });
		expect(error.message).toBe('Not found');
		expect(error.code).toBe('NOT_FOUND');
		expect(error.id).toBe(7);
		expect(error.table).toBe('users');
		expect(error.columns).toEqual([]);
		expect(error.sqlState).toBeUndefined();
		expect(new ConflictError().sqlState).toBe('23505');
		expect(new ForeignKeyError().sqlState).toBe('23503');
		expect(new CheckViolationError().sqlState).toBe('23514');
		expect(new NotNullViolationError().sqlState).toBe('23502');
		expect(new DataError('x').code).toBe('DATABASE');
	});
});

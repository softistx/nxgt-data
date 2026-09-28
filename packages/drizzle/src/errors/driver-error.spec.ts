import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { findDriverError } from './driver-error';

describe('findDriverError', () => {
	test('reads the SQLSTATE from code, as node-postgres, postgres.js and PGlite send it', () => {
		expect(findDriverError({ code: '23505' })?.sqlState).toBe('23505');
	});

	test("reads the SQLSTATE from errno when code is Bun's own", () => {
		const bun = new SQL.PostgresError('x', {
			code: 'ERR_POSTGRES_SERVER_ERROR',
			errno: '23505',
		});
		expect(findDriverError(bun)?.sqlState).toBe('23505');
	});

	test('prefers code when both carry a SQLSTATE', () => {
		expect(findDriverError({ code: '23505', errno: '42P01' })?.sqlState).toBe(
			'23505',
		);
	});

	test('takes no numeric errno, as a Node system error or a MySQL error has', () => {
		expect(findDriverError({ code: 'ENOENT', errno: -2 })).toBeUndefined();
		expect(
			findDriverError({ code: 'ER_DUP_ENTRY', errno: 1062 }),
		).toBeUndefined();
	});

	test('takes no errno that is not a SQLSTATE', () => {
		expect(
			findDriverError({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '2350' }),
		).toBeUndefined();
	});

	test("ignores Bun's numeric column, which is the stack frame's", () => {
		// Measured: a unique violation from Bun's SQL has `column: 27`.
		const found = findDriverError({
			code: 'ERR_POSTGRES_SERVER_ERROR',
			errno: '23505',
			column: 27,
		});
		expect(found?.column).toBeUndefined();
	});

	test("finds Bun's error under Drizzle's wrapper", () => {
		const bun = new SQL.PostgresError('x', {
			code: 'ERR_POSTGRES_SERVER_ERROR',
			errno: '42P01',
		});
		const wrapped = new Error('Failed query', { cause: bun });
		expect(findDriverError(wrapped)?.sqlState).toBe('42P01');
	});

	test('reads postgres.js field names', () => {
		expect(
			findDriverError({
				code: '23502',
				table_name: 't',
				constraint_name: 'c',
				column_name: 'col',
			}),
		).toEqual({
			sqlState: '23502',
			message: undefined,
			detail: undefined,
			table: 't',
			constraint: 'c',
			column: 'col',
		});
	});

	test("reads postgres.js's column_name past the numeric column every Error has on Bun", () => {
		// postgres.js assigns its fields onto a real `Error`, which on Bun
		// already holds JavaScriptCore's numeric `column`.
		const driver = Object.assign(new Error('null value in column "email"'), {
			code: '23502',
			table_name: 'users',
			column_name: 'email',
		});
		expect(findDriverError(driver)?.column).toBe('email');
	});

	test('stops after eight links', () => {
		let error: unknown = { code: '23505' };
		for (let i = 0; i < 8; i++) error = { cause: error };
		expect(findDriverError(error)).toBeUndefined();
	});
});

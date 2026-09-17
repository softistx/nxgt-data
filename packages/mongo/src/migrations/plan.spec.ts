import { describe, expect, test } from 'bun:test';
import { defineMigration } from './define-migration';
import { MigrationError } from './errors';
import { checkList, statusOf, toApply, toRevert } from './plan';
import type { MigrationRecord } from './types';

const noop = async () => {};
const m = (id: string, down = true) =>
	defineMigration({ id, up: noop, ...(down ? { down: noop } : {}) });
const list = [m('a'), m('b'), m('c')];
const at = new Date('2026-01-01T00:00:00Z');
const recorded = (...ids: string[]): MigrationRecord[] =>
	ids.map((id) => ({ _id: id, appliedAt: at, durationMs: 1 }));
const ids = (steps: ({ id: string } | { migration: { id: string } })[]) =>
	steps.map((x) => ('migration' in x ? x.migration.id : x.id));

describe('defineMigration', () => {
	test('keeps what it is given, transaction on by default', () => {
		const migration = defineMigration({ id: '2026-09-17_x.y:z', up: noop });
		expect(migration).toEqual({
			id: '2026-09-17_x.y:z',
			up: noop,
			down: undefined,
			transaction: true,
		});
		expect(Object.isFrozen(migration)).toBe(true);
		expect(
			defineMigration({ id: 'a', up: noop, transaction: false }).transaction,
		).toBe(false);
	});

	test.each(['', 'has space', 'a/b', '#lock'])('refuses the id %p', (id) => {
		expect(() => defineMigration({ id, up: noop })).toThrow(
			'is not a migration id',
		);
	});

	test('refuses an id that is not a string', () => {
		// @ts-expect-error an id is a string
		expect(() => defineMigration({ id: 3, up: noop })).toThrow(
			'is not a migration id',
		);
	});

	test('refuses a missing up, and a down that is not a function', () => {
		// @ts-expect-error a migration has an up
		expect(() => defineMigration({ id: 'a' })).toThrow('"a" has no up');
		expect(() =>
			// @ts-expect-error a down is a function
			defineMigration({ id: 'a', up: noop, down: 'no' }),
		).toThrow('"a" has a down that is not a function');
	});
});

describe('the list against the records', () => {
	test('an id listed twice is refused', () => {
		expect(() => checkList([m('a'), m('b'), m('a')])).toThrow(
			'Migration "a" is listed twice',
		);
	});

	test('status: applied, pending, and missing after the list', () => {
		expect(statusOf(list, recorded('a', 'gone'))).toEqual([
			{ id: 'a', state: 'applied', appliedAt: at },
			{ id: 'b', state: 'pending', appliedAt: undefined },
			{ id: 'c', state: 'pending', appliedAt: undefined },
			{ id: 'gone', state: 'missing', appliedAt: at },
		]);
	});

	test('the pending ones, in order, up to `to`', () => {
		expect(ids(toApply(list, [], undefined))).toEqual(['a', 'b', 'c']);
		expect(ids(toApply(list, recorded('a'), undefined))).toEqual(['b', 'c']);
		expect(ids(toApply(list, recorded('a'), 'b'))).toEqual(['b']);
		expect(ids(toApply(list, recorded('a', 'b'), 'a'))).toEqual([]);
		expect(ids(toApply(list, recorded('a', 'b', 'c'), undefined))).toEqual([]);
	});

	test('a recorded migration the list lost is refused', () => {
		let error: unknown;
		try {
			toApply(list, recorded('a', 'gone'), undefined);
		} catch (caught) {
			error = caught;
		}
		if (!(error instanceof MigrationError)) throw error;
		expect(error.code).toBe('MIGRATION');
		expect(error.migration).toBe('gone');
		expect(error.message).toContain('no longer in the list');
	});

	test('a pending migration listed before an applied one is refused', () => {
		expect(() => toApply(list, recorded('a', 'c'), undefined)).toThrow(
			'Migration "b" is pending and listed before one that is already applied',
		);
		expect(() => toRevert(list, recorded('b'), undefined)).toThrow(
			'Migration "a" is pending',
		);
	});

	test('`to` must be in the list', () => {
		expect(() => toApply(list, [], 'nope')).toThrow(
			'migrate: "nope" is not in the list',
		);
		expect(() => toRevert(list, recorded('a'), 'nope')).toThrow(
			'rollback: "nope" is not in the list',
		);
	});
});

describe('what a rollback undoes', () => {
	test('the last applied one, alone', () => {
		expect(ids(toRevert(list, recorded('a', 'b'), undefined))).toEqual(['b']);
		expect(ids(toRevert(list, [], undefined))).toEqual([]);
	});

	test('every one after `to`, the last first', () => {
		expect(ids(toRevert(list, recorded('a', 'b', 'c'), 'a'))).toEqual([
			'c',
			'b',
		]);
		expect(ids(toRevert(list, recorded('a', 'b'), 'b'))).toEqual([]);
		expect(ids(toRevert(list, recorded('a'), 'c'))).toEqual([]);
	});

	test('refused as a whole when one has no down', () => {
		const mixed = [m('a'), m('b', false), m('c')];
		expect(() => toRevert(mixed, recorded('a', 'b', 'c'), 'a')).toThrow(
			'Migration "b" has no down, so it cannot be rolled back',
		);
		expect(ids(toRevert(mixed, recorded('a', 'b', 'c'), 'b'))).toEqual(['c']);
	});
});

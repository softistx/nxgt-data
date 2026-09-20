import {
	and,
	asc,
	Column,
	desc,
	eq,
	gt,
	is,
	isNull,
	lt,
	or,
	SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ArgumentError } from '../../errors/argument-error';
import type { TableInfo } from './table-info';
import type { OrderDirection } from './types';

function columnAt(info: TableInfo, key: string, what: string): PgColumn {
	const column = info.columns[key];
	if (!column) {
		throw new ArgumentError(
			what,
			`${what}: "${info.name}" has no column under the key "${key}"`,
			{ key },
		);
	}
	return column;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!is(value, SQL) &&
		!is(value, Column)
	);
}

/**
 * A `where` as SQL: a Drizzle condition as it is, an object as one equality
 * per key. A key set to `undefined` throws rather than being left out: left
 * out, `{ id: undefined }` would match every row, and an `updateMany` would
 * update them all.
 */
export function whereToSql(info: TableInfo, where: unknown): SQL | undefined {
	if (where === undefined) return undefined;
	if (is(where, SQL)) return where;
	if (!isPlainObject(where)) {
		throw new ArgumentError(
			'where',
			'where: expected a Drizzle condition or an object',
		);
	}
	const conditions: SQL[] = [];
	for (const [key, value] of Object.entries(where)) {
		if (value === undefined) {
			throw new ArgumentError(
				'where',
				`where: "${key}" is undefined. Leave the key out, or pass null for IS NULL`,
				{ key },
			);
		}
		const column = columnAt(info, key, 'where');
		conditions.push(value === null ? isNull(column) : eq(column, value));
	}
	return and(...conditions);
}

/** Whether a `where` would match every row: missing, or an empty object. */
export function isEmptyWhere(where: unknown): boolean {
	return (
		where === undefined ||
		(isPlainObject(where) && Object.keys(where).length === 0)
	);
}

type Ordering = SQL | SQL.Aliased | PgColumn;

export function orderByToSql(info: TableInfo, orderBy: unknown): Ordering[] {
	if (orderBy === undefined) return [];
	if (Array.isArray(orderBy)) return orderBy as Ordering[];
	if (is(orderBy, SQL) || is(orderBy, SQL.Aliased) || is(orderBy, Column)) {
		return [orderBy as Ordering];
	}
	if (!isPlainObject(orderBy)) {
		throw new ArgumentError(
			'orderBy',
			'orderBy: expected a Drizzle ordering, a list, or an object',
		);
	}
	return Object.entries(orderBy).map(([key, direction]) => {
		const column = columnAt(info, key, 'orderBy');
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ArgumentError(
				'orderBy',
				`orderBy: "${key}" must be 'asc' or 'desc', not ${String(direction)}`,
				{ key },
			);
		}
		return direction === 'asc' ? asc(column) : desc(column);
	});
}

/**
 * The rows after the one whose ordering values are `values`, for a keyset
 * ordered by `columns` in `direction`: `a > x OR (a = x AND b > y)`.
 */
export function keysetAfter(
	columns: readonly PgColumn[],
	values: readonly unknown[],
	direction: OrderDirection,
): SQL | undefined {
	const past = direction === 'asc' ? gt : lt;
	const branches: (SQL | undefined)[] = columns.map((column, index) =>
		and(
			...columns.slice(0, index).map((previous, i) => eq(previous, values[i])),
			past(column, values[index]),
		),
	);
	return or(...branches);
}

export { columnAt };

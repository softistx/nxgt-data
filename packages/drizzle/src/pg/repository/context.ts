import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { NotFoundError } from '../../errors/data-error';
import { toDataError } from '../../errors/to-data-error';
import { DEFAULT_MAX_PAGE_SIZE } from '../../pagination/page';
import { refuseHeldDatabase } from '../transaction/open-transaction';
import type { TableInfo } from './table-info';
import type { PgDatabase, RepositoryOptions } from './types';

/** A row of this table, as this layer handles it: by key, untyped. */
export type AnyRow = Record<string, unknown>;

/**
 * What every method of a repository works from, resolved once: the database,
 * the table, what was read off it, and the options.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `filters.ts`, `stamp-writes.ts` and `operations/` —
 * a context of closures would only be the factory this package split up, one
 * size down. `@nxgt/mongo`'s `collection/context.ts` is the same seam.
 *
 * `with()` builds another one through `rebound`, cheaply: the same repository
 * on a different database.
 */
export interface RepositoryContext {
	readonly db: PgDatabase;
	readonly table: PgTable;
	readonly info: TableInfo;
	readonly maxPageSize: number;
	/**
	 * Whether a caller named this database themselves, through `with()`. A
	 * repository that came out of `createRepository` did not, and is the one
	 * `refuseHeldDatabase` protects inside an open transaction.
	 */
	readonly explicit: boolean;
}

export function createContext(
	db: PgDatabase,
	table: PgTable,
	info: TableInfo,
	options: RepositoryOptions<any, any, any>,
): RepositoryContext {
	return {
		db,
		table,
		info,
		maxPageSize: options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
		explicit: false,
	};
}

/**
 * The same repository on another database, as `with()` gives it back.
 *
 * `explicit` is set here and nowhere else: naming a database is what tells
 * `refuseHeldDatabase` the caller meant this one.
 */
export function rebound(
	ctx: RepositoryContext,
	db: PgDatabase,
): RepositoryContext {
	return { ...ctx, db, explicit: true };
}

/**
 * The database and the table, loosely typed, for the query builders.
 *
 * Drizzle's builders are typed per table; this layer works on any table, and
 * the public type is what callers see. They are **read from the context, not
 * held on it**: a second copy of the database on the context is a field that
 * can drift from `db`, and `run`'s guard compares `db` while every query runs
 * on the copy — so the deadlock `refuseHeldDatabase` exists to prevent would
 * come back with nothing to catch it.
 */
export function builders(ctx: RepositoryContext): { d: any; t: any } {
	return { d: ctx.db, t: ctx.table };
}

/**
 * Runs an operation, turning a PostgreSQL error into a `DataError`.
 *
 * Every database access a repository makes goes through here, so the one
 * `refuseHeldDatabase` covers every method, including the ones that reach the
 * database through another (`paginate` through `findMany` and `count`). It
 * runs **before** the `try`, deliberately: inside it, `toDataError` would
 * swallow the refusal and hand back the wrong class.
 */
export async function run<R>(
	ctx: RepositoryContext,
	fn: () => Promise<R>,
): Promise<R> {
	refuseHeldDatabase(ctx.info.name, ctx.db, ctx.explicit);
	try {
		return await fn();
	} catch (error) {
		throw toDataError(error);
	}
}

/**
 * The single column a row is addressed by, or the reason there is none.
 *
 * Resolved on use rather than in `createContext`: a table with no single-column
 * primary key still reads, writes and paginates by `where`, and only the
 * methods that take an id have nothing to work with.
 */
export function primaryKey(ctx: RepositoryContext): {
	key: string;
	column: PgColumn;
} {
	const pk = ctx.info.primaryKey;
	if ('error' in pk) throw new TypeError(pk.error);
	return pk;
}

export function notFound(ctx: RepositoryContext, id: unknown): NotFoundError {
	return new NotFoundError(
		`No row in "${ctx.info.name}" with ${primaryKey(ctx).key} ${String(id)}`,
		{ table: ctx.info.name, id },
	);
}

import type { PgTable } from 'drizzle-orm/pg-core';
import type { Patch, PrimaryKeyOf } from './columns';

/**
 * The values `update` takes: no primary key — an update never moves a row to
 * another key — and, on a repository that locks, `version` is the version the
 * row must still be at — a whole number, never SQL — and not a value to write.
 *
 * The types leave out `TKey`: the column `primaryKey` names, else `id` when
 * the table has one (`PrimaryKeyOf<TTable>`, `never` without one); every other
 * primary-key column is refused at run time only. Drizzle 1.0's PostgreSQL
 * column types do not say which columns a key covers.
 */
export type UpdatePatch<
	TTable extends PgTable,
	TLock extends boolean,
	TKey extends PropertyKey = PrimaryKeyOf<TTable>,
> = TLock extends true
	? Omit<Patch<TTable>, 'version' | TKey> & { version?: number } & {
			[K in TKey]?: undefined;
		}
	: Omit<Patch<TTable>, TKey> & { [K in TKey]?: undefined };

/**
 * The values `updateMany` takes: no primary key, as for `update`, and on a
 * repository that locks, no `version` — one version cannot stand for many
 * rows, and every update raises it.
 */
export type ManyPatch<
	TTable extends PgTable,
	TLock extends boolean,
	TKey extends PropertyKey = PrimaryKeyOf<TTable>,
> = TLock extends true
	? Omit<Patch<TTable>, 'version' | TKey> & { version?: never } & {
			[K in TKey]?: undefined;
		}
	: Omit<Patch<TTable>, TKey> & { [K in TKey]?: undefined };

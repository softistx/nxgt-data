import type { PgTable } from 'drizzle-orm/pg-core';
import type { Insert, LockOf, Row } from './columns';

/**
 * What identifies the row an `upsert` writes: its values under columns a
 * unique constraint covers. Plain values — no SQL, no `null`, which never
 * conflicts — since they are inserted as well as matched.
 */
export type UpsertWhere<
	TTable extends PgTable,
	TLock extends boolean = LockOf<TTable>,
> = {
	[K in Exclude<
		keyof Row<TTable>,
		TLock extends true ? 'version' : never
	>]?: NonNullable<Row<TTable>[K]>;
};

/**
 * The `where` an `upsert` takes: no key but the table's, and at least one —
 * `{}` has nothing to conflict on.
 */
export type UpsertWhereOf<
	TTable extends PgTable,
	TLock extends boolean,
	W,
> = W & {
	[K in Exclude<keyof W, keyof UpsertWhere<TTable, TLock>>]: never;
} & ([keyof W] extends [never] ? { 'upsert needs a key': never } : unknown);

/**
 * What an `upsert` writes, either way: the insert values without the keys the
 * `where` already gives, so a required column is required here only when the
 * `where` does not name it. On a repository that locks, no `version`.
 */
export type UpsertValues<
	TTable extends PgTable,
	TWhereKey extends PropertyKey,
	TLock extends boolean,
> = TLock extends true
	? Omit<Insert<TTable>, TWhereKey | 'version'> & { version?: never }
	: Omit<Insert<TTable>, TWhereKey>;

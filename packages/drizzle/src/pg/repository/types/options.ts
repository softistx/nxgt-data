import type { PgTable } from 'drizzle-orm/pg-core';
import type { ActorOf, ColumnKey, LockOf } from './columns';

/** What `update` and `updateMany` take beside the patch. */
export interface UpdateOptions {
	/**
	 * `false` makes the update silent: `updatedAt`, `updatedBy` and the
	 * version are left as they were, and so is every column declared with
	 * `$onUpdate`, which keeps its stored value. A
	 * version the patch gives is still checked, and a stamp the patch sets
	 * itself is still written. The write runs in the repository's
	 * transaction (`with(tx)`) and is checked like any other. Default `true`.
	 */
	audit?: boolean | undefined;
	/** Not an option: bind a transaction with `with(tx)`. */
	session?: never;
	/** Not an option: bind a transaction with `with(tx)`. */
	tx?: never;
}

export interface RepositoryOptions<
	TTable extends PgTable,
	TKey extends ColumnKey<TTable>,
	TSoft extends boolean,
	TLock extends boolean = LockOf<TTable>,
> {
	/**
	 * The column `findById`, `update(id)` and `delete(id)` look rows up by.
	 * Default: the one declared with `.primaryKey()`. Name one for a table
	 * with a composite primary key; it should be unique.
	 */
	primaryKey?: TKey;
	/**
	 * Soft delete through the `deletedAt` column. Default: on when the table
	 * has one. `false` makes `delete` a real `DELETE`.
	 */
	softDelete?: TSoft;
	/**
	 * Set the `updatedAt` column to `now()` on every update the patch does not
	 * set it in. Default `true`. A column with `$onUpdate` is left to Drizzle.
	 */
	touchUpdatedAt?: boolean;
	/**
	 * Optimistic locking through the `version` column. Default: on when the
	 * table has an integer `version` that is `NOT NULL`. Every update raises
	 * it, and `update` checks the `version` a patch gives instead of writing
	 * it. `false` makes `version` an ordinary column.
	 */
	optimisticLock?: LockOf<TTable> extends true ? TLock : false;
	/**
	 * Who is writing, stamped into `createdBy`, `updatedBy` and `deletedBy`.
	 * `as(actor)` is the same thing, later.
	 */
	actor?: ActorOf<TTable>;
	/** The largest `pageSize` or `limit` a page may ask for. Default `100`. */
	maxPageSize?: number;
}

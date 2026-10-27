import type { InferSelectModel } from 'drizzle-orm';
import type {
	PgAsyncDatabase,
	PgInsertValue,
	PgQueryResultHKT,
	PgTable,
	PgUpdateSetSource,
} from 'drizzle-orm/pg-core';

/**
 * A PostgreSQL database or transaction, whatever the driver: `drizzle-orm/
 * node-postgres`, `postgres-js`, `bun-sql`, `pglite`, `neon-serverless`… A transaction
 * is one, so everything that takes a database takes a transaction.
 */
export type PgDatabase = PgAsyncDatabase<PgQueryResultHKT, any>;

/** A row as the table returns it: `table.$inferSelect`. */
export type Row<TTable extends PgTable> = InferSelectModel<TTable>;

/** The values `create` takes: `table.$inferInsert`, or SQL for any of them. */
export type Insert<TTable extends PgTable> = PgInsertValue<TTable>;

/** The values `update` takes: any of the insert values, or SQL. */
export type Patch<TTable extends PgTable> = PgUpdateSetSource<TTable>;

/** A column's key on the table object, which is also its key on a row. */
export type ColumnKey<TTable extends PgTable> = keyof TTable['_']['columns'] &
	string;

/**
 * The key the methods by id use when `primaryKey` is not given: `id`, when
 * the table has a column under it, and `never` otherwise, which leaves them
 * uncallable. Drizzle 1.0's column types do not carry `.primaryKey()`, so
 * the key cannot be read from the table's type.
 */
export type PrimaryKeyOf<TTable extends PgTable> =
	'id' extends ColumnKey<TTable> ? 'id' : never;

/** Whether the table has a column under this key. */
export type HasColumn<TTable extends PgTable, K extends string> =
	K extends ColumnKey<TTable> ? true : false;

/** The integer `dataType`s Drizzle gives a column read back as a `number`. */
type Counter = 'number int16' | 'number int32' | 'number int53';

/**
 * Whether a repository on this table locks by default: it has an integer
 * `version` that is `NOT NULL`. A nullable one, or a `double`, `real` or
 * `numeric` one — a `number` too, but not a counter — is an ordinary column,
 * as it is at run time: both read the column's `dataType`.
 */
export type LockOf<TTable extends PgTable> =
	'version' extends ColumnKey<TTable>
		? Row<TTable>['version' & keyof Row<TTable>] extends number
			? TTable['_']['columns']['version']['_']['dataType'] extends Counter
				? true
				: false
			: false
		: false;

/** The actor's type under one column key, or `never` without that column. */
type ActorUnder<TTable extends PgTable, K extends string> =
	K extends ColumnKey<TTable>
		? NonNullable<Row<TTable>[K & keyof Row<TTable>]>
		: never;

/**
 * Who is writing: the type of the first actor column there is — `createdBy`,
 * then `updatedBy`, then `deletedBy`. A table with none of the three has no
 * actor to stamp, and `as` cannot be called on it.
 */
export type ActorOf<TTable extends PgTable> = [
	ActorUnder<TTable, 'createdBy'>,
] extends [never]
	? [ActorUnder<TTable, 'updatedBy'>] extends [never]
		? ActorUnder<TTable, 'deletedBy'>
		: ActorUnder<TTable, 'updatedBy'>
	: ActorUnder<TTable, 'createdBy'>;

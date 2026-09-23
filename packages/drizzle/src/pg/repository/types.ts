import type { InferSelectModel, SQL } from 'drizzle-orm';
import type {
	PgAsyncDatabase,
	PgColumn,
	PgInsertValue,
	PgQueryResultHKT,
	PgTable,
	PgUpdateSetSource,
} from 'drizzle-orm/pg-core';
import type { CursorPage, Page, PageOptions } from '../../pagination/page';

/**
 * A PostgreSQL database or transaction, whatever the driver: `drizzle-orm/
 * node-postgres`, `postgres-js`, `pglite`, `neon-serverless`… A transaction
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

/**
 * Whether a repository on this table locks by default: it has an integer
 * `version` that is `NOT NULL`. A nullable or a non-integer `version` is an
 * ordinary column, as it is at run time.
 */
export type LockOf<TTable extends PgTable> =
	'version' extends ColumnKey<TTable>
		? Row<TTable>['version' & keyof Row<TTable>] extends number
			? true
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

/**
 * The values `update` takes. On a repository that locks, `version` is the
 * version the row must still be at — a whole number, never SQL — and not a
 * value to write.
 */
export type UpdatePatch<
	TTable extends PgTable,
	TLock extends boolean,
> = TLock extends true
	? Omit<Patch<TTable>, 'version'> & { version?: number }
	: Patch<TTable>;

/**
 * The values `updateMany` takes: on a repository that locks, no `version` —
 * one version cannot stand for many rows, and every update raises it.
 */
export type ManyPatch<
	TTable extends PgTable,
	TLock extends boolean,
> = TLock extends true
	? Omit<Patch<TTable>, 'version'> & { version?: never }
	: Patch<TTable>;

/**
 * What identifies the row an `upsert` writes: its values under columns a
 * unique constraint covers. Plain values — no SQL, no `null`, which never
 * conflicts — since they are inserted as well as matched.
 */
export type UpsertWhere<TTable extends PgTable> = {
	[K in keyof Row<TTable>]?: NonNullable<Row<TTable>[K]>;
};

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

/**
 * Rows whose columns equal these values: `{ email: 'ada@example.com' }`.
 * `null` matches `IS NULL`. Several keys are joined with `AND`.
 */
export type WhereObject<TTable extends PgTable> = {
	[K in keyof Row<TTable>]?: Row<TTable>[K];
};

/** A Drizzle condition (`eq`, `and`, `sql`…) or a `WhereObject`. */
export type Where<TTable extends PgTable> =
	| SQL
	| WhereObject<TTable>
	| undefined;

export type OrderDirection = 'asc' | 'desc';

/**
 * A Drizzle ordering (`asc(t.name)`, a column, `sql`…), a list of them, or an
 * object of directions by key: `{ createdAt: 'desc', id: 'asc' }`, in its
 * key order.
 */
export type OrderBy<TTable extends PgTable> =
	| SQL
	| SQL.Aliased
	| PgColumn
	| ReadonlyArray<SQL | SQL.Aliased | PgColumn>
	| { [K in keyof Row<TTable>]?: OrderDirection };

export interface ReadOptions {
	/** Include soft-deleted rows. Ignored on a table without soft delete. */
	withDeleted?: boolean;
}

export interface FindFirstOptions<TTable extends PgTable> extends ReadOptions {
	orderBy?: OrderBy<TTable>;
}

export interface FindManyOptions<TTable extends PgTable> extends ReadOptions {
	where?: Where<TTable>;
	orderBy?: OrderBy<TTable>;
	limit?: number;
	offset?: number;
}

export interface PaginateOptions<TTable extends PgTable>
	extends PageOptions,
		ReadOptions {
	where?: Where<TTable>;
	/** Default: the primary key, ascending, so that pages are stable. */
	orderBy?: OrderBy<TTable>;
}

export interface CursorPaginateOptions<TTable extends PgTable>
	extends ReadOptions {
	/** The `nextCursor` of the previous page. Omit it for the first page. */
	after?: string | null | undefined;
	/** Rows per page. Default `20`, at most `maxPageSize`. */
	limit?: number;
	where?: Where<TTable>;
	/**
	 * The column to page along. Default: the primary key. Any other is
	 * followed by the primary key, which breaks its ties. It must be
	 * `NOT NULL`.
	 */
	orderBy?: ColumnKey<TTable>;
	/** Default `'asc'`. */
	direction?: OrderDirection;
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
	optimisticLock?: TLock;
	/**
	 * Who is writing, stamped into `createdBy`, `updatedBy` and `deletedBy`.
	 * `as(actor)` is the same thing, later.
	 */
	actor?: ActorOf<TTable>;
	/** The largest `pageSize` or `limit` a page may ask for. Default `100`. */
	maxPageSize?: number;
}

export interface BaseRepository<
	TTable extends PgTable,
	TKey extends ColumnKey<TTable>,
	TSoft extends boolean,
	TLock extends boolean = LockOf<TTable>,
> {
	readonly table: TTable;
	readonly db: PgDatabase;
	/** The same repository on another database or transaction. */
	with(db: PgDatabase): Repository<TTable, TKey, TSoft, TLock>;
	/**
	 * The same repository, stamping `createdBy`, `updatedBy` and `deletedBy`
	 * with this actor. Uncallable on a table with none of the three.
	 */
	as(actor: ActorOf<TTable>): Repository<TTable, TKey, TSoft, TLock>;

	/** The row with this id, or `undefined`. */
	findById(
		id: Row<TTable>[TKey],
		options?: ReadOptions,
	): Promise<Row<TTable> | undefined>;
	/** The row with this id. Throws `NotFoundError`. */
	getById(id: Row<TTable>[TKey], options?: ReadOptions): Promise<Row<TTable>>;
	/** The first row that matches, or `undefined`. */
	findFirst(
		where?: Where<TTable>,
		options?: FindFirstOptions<TTable>,
	): Promise<Row<TTable> | undefined>;
	/** Every row that matches. */
	findMany(options?: FindManyOptions<TTable>): Promise<Row<TTable>[]>;
	/** Inserts a row and returns it. */
	create(values: Insert<TTable>): Promise<Row<TTable>>;
	/** Inserts rows in one statement and returns them. `[]` sends nothing. */
	createMany(values: readonly Insert<TTable>[]): Promise<Row<TTable>[]>;
	/**
	 * Updates the row with this id and returns it. Throws `NotFoundError`, and
	 * `OptimisticLockError` when the patch gives a `version` the row is no
	 * longer at.
	 */
	update(
		id: Row<TTable>[TKey],
		patch: UpdatePatch<TTable, TLock>,
	): Promise<Row<TTable>>;
	/**
	 * Updates every row that matches and returns them. `where` is required:
	 * pass `` sql`true` `` to update every row.
	 */
	updateMany(
		where: Where<TTable>,
		patch: ManyPatch<TTable, TLock>,
	): Promise<Row<TTable>[]>;
	/**
	 * Inserts the row the `where` identifies, or updates the live one that is
	 * already there, in one statement: `INSERT … ON CONFLICT (<the where's
	 * columns>) DO UPDATE`. A unique constraint must cover exactly those
	 * columns. Throws `ConflictError` when the row there is soft-deleted.
	 */
	upsert<const W extends UpsertWhere<TTable>>(
		where: W & { [K in Exclude<keyof W, keyof Row<TTable>>]: never },
		values: UpsertValues<TTable, keyof W, TLock>,
	): Promise<Row<TTable>>;
	/**
	 * Deletes the row with this id and returns it: a soft delete on a table
	 * with soft delete. Throws `NotFoundError`.
	 */
	delete(id: Row<TTable>[TKey]): Promise<Row<TTable>>;
	/** Deletes every row that matches and returns them. `where` is required. */
	deleteMany(where: Where<TTable>): Promise<Row<TTable>[]>;
	/** How many rows match. */
	count(where?: Where<TTable>, options?: ReadOptions): Promise<number>;
	/** Whether any row matches. */
	exists(where: Where<TTable>, options?: ReadOptions): Promise<boolean>;
	/** One page of the rows that match, and how many there are. */
	paginate(options?: PaginateOptions<TTable>): Promise<Page<Row<TTable>>>;
	/** One page of the rows that match, after a cursor. */
	paginateByCursor(
		options?: CursorPaginateOptions<TTable>,
	): Promise<CursorPage<Row<TTable>>>;
}

/** What a repository on a table with soft delete adds. */
export interface SoftDeleteMethods<
	TTable extends PgTable,
	TKey extends ColumnKey<TTable>,
> {
	/** A real `DELETE`, of a live or a soft-deleted row. Throws `NotFoundError`. */
	hardDelete(id: Row<TTable>[TKey]): Promise<Row<TTable>>;
	/** A real `DELETE` of every row that matches, soft-deleted ones included. */
	hardDeleteMany(where: Where<TTable>): Promise<Row<TTable>[]>;
	/** Clears `deletedAt` and returns the row. Throws `NotFoundError`. */
	restore(id: Row<TTable>[TKey]): Promise<Row<TTable>>;
}

export type Repository<
	TTable extends PgTable,
	TKey extends ColumnKey<TTable> = PrimaryKeyOf<TTable>,
	TSoft extends boolean = HasColumn<TTable, 'deletedAt'>,
	TLock extends boolean = LockOf<TTable>,
> = BaseRepository<TTable, TKey, TSoft, TLock> &
	(TSoft extends true ? SoftDeleteMethods<TTable, TKey> : unknown);

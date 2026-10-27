import type { PgTable } from 'drizzle-orm/pg-core';
import type { CursorPage, Page } from '../../../pagination/page';
import type {
	ActorOf,
	ColumnKey,
	HasColumn,
	Insert,
	LockOf,
	PgDatabase,
	PrimaryKeyOf,
	Row,
} from './columns';
import type { UpdateOptions } from './options';
import type { ManyPatch, UpdatePatch } from './patches';
import type {
	CursorPaginateOptions,
	FindFirstOptions,
	FindManyOptions,
	PaginateOptions,
	ReadOptions,
	Where,
} from './reads';
import type { UpsertValues, UpsertWhere, UpsertWhereOf } from './upsert';

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
	 * longer at. `{ audit: false }` is a silent update.
	 */
	update(
		id: Row<TTable>[TKey],
		patch: UpdatePatch<TTable, TLock, TKey>,
		options?: UpdateOptions,
	): Promise<Row<TTable>>;
	/**
	 * Updates every row that matches and returns them. `where` is required:
	 * pass `` sql`true` `` to update every row.
	 */
	updateMany(
		where: Where<TTable>,
		patch: ManyPatch<TTable, TLock, TKey>,
		options?: UpdateOptions,
	): Promise<Row<TTable>[]>;
	/**
	 * Inserts the row the `where` identifies, or updates the live one that is
	 * already there, in one statement: `INSERT … ON CONFLICT (<the where's
	 * columns>) DO UPDATE`. A unique constraint must cover exactly those
	 * columns. Throws `ConflictError` when the row there is soft-deleted.
	 */
	upsert<const W extends UpsertWhere<TTable, TLock>>(
		where: UpsertWhereOf<TTable, TLock, W>,
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

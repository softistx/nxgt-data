import type { CursorPage } from '@nxgt/drizzle';
import type { Row } from '@nxgt/drizzle/pg';
import type {
	AnyIndexDefinition,
	DocumentOf,
	IdOf,
	TypedIndex,
} from '@nxgt/meilisearch';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Where the rows come from: what this package needs of an `@nxgt/drizzle`
 * repository, and nothing more.
 *
 * A `Repository` from `createRepository` satisfies it, and so does one
 * narrowed by `with(tx)`. Written as its own shape rather than as
 * `Repository<TTable>`, whose second and third parameters describe the
 * primary key and the soft delete — neither of which this package reads.
 */
export interface SyncRepository<TTable extends PgTable> {
	readonly table: TTable;
	paginateByCursor(options?: {
		after?: string | null | undefined;
		limit?: number;
	}): Promise<CursorPage<Row<TTable>>>;
}

/**
 * What a row becomes in the index: a document, or `null` to keep it out —
 * and take it out, if it was in.
 */
export type Transform<TTable extends PgTable, I extends AnyIndexDefinition> = (
	row: Row<TTable>,
) => DocumentOf<I> | null | Promise<DocumentOf<I> | null>;

/**
 * The index id of a row.
 *
 * Required, not defaulted: Drizzle 1.0's column types do not carry
 * `.primaryKey()`, so neither the repository nor the table can say which
 * column the id is in — `@nxgt/drizzle`'s own `PrimaryKeyOf` falls back to
 * the key `id` for exactly that reason. One line per sync says it outright,
 * and says it where the index's own id type can check it.
 */
export type ToIndexId<TTable extends PgTable, I extends AnyIndexDefinition> = (
	row: Row<TTable>,
) => IdOf<I>;

/** What one write to the index takes. */
export interface IndexWriteOptions {
	/**
	 * Whether to wait for Meilisearch to apply the write. Default `false`:
	 * indexing is asynchronous there, and a request that has just written a
	 * row should not hold its response open for it. `true` waits, which is
	 * what a script or a test wants.
	 */
	wait?: boolean;
}

export interface SearchSyncOptions<
	TTable extends PgTable,
	I extends AnyIndexDefinition,
> {
	/** Where the rows are: a repository from `createRepository`. */
	repository: SyncRepository<TTable>;
	/** Where they go: an index from `bindIndex`. */
	index: TypedIndex<I>;
	/**
	 * A row as the index holds it. Its primary key must be the row's index
	 * id. `null` keeps a row out of the index, and takes it out if it was in.
	 */
	transform: Transform<TTable, I>;
	/** The index id of a row. */
	toIndexId: ToIndexId<TTable, I>;
	/** What this sync is called in its errors. Default `'<table>:<index uid>'`. */
	name?: string;
	/** How many documents are sent to Meilisearch at once. Default `500`. */
	batchSize?: number;
	/** How many rows `reindexAll` reads per page. Default `100`. */
	pageSize?: number;
}

/** Where a `reindexAll` is, after a page: the running counts, so far. */
export interface ReindexProgress {
	/** Pages read, sent and applied. */
	readonly pages: number;
	/** Rows sent to the index so far. */
	readonly indexed: number;
	/** Rows the transform kept out so far. */
	readonly skipped: number;
}

export interface ReindexOptions {
	/** How many rows to read per page; wins over the sync's own `pageSize`. */
	pageSize?: number;
	/**
	 * Called after each page, once its documents are applied, with the
	 * running counts — for a deployment step or a script that reports where
	 * it is. Awaited when it returns a promise. One that throws stops the
	 * reindex, which rejects with it as the `cause` of a `FAILED`; the
	 * documents already sent stay, and removing the leftovers never ran.
	 */
	onPage?: (progress: ReindexProgress) => void | Promise<void>;
}

export interface ReindexReport {
	/** Rows sent to the index. */
	indexed: number;
	/** Rows the transform kept out. */
	skipped: number;
	/** Documents that were in the index and the table no longer wants there. */
	removed: number;
}

/**
 * A table and an index, kept in step by the calls an application already
 * makes.
 *
 * There is no `start()`: PostgreSQL has no change feed this package could
 * follow the way `@nxgt/mongo-meilisearch` follows a change stream, so what
 * it removes is the collage around a write — the transform, the id, the
 * batching, the delete of a row that stopped qualifying — and not the
 * decision of when to index. See `docs/roadmap.md`.
 */
export interface SearchSync<
	TTable extends PgTable,
	I extends AnyIndexDefinition,
> {
	readonly name: string;
	/**
	 * Every row the repository pages through, transformed and sent, then the
	 * documents the index holds and the table no longer wants, removed.
	 *
	 * It waits for each batch to be applied, because what it removes is
	 * decided by reading the index back.
	 */
	reindexAll(options?: ReindexOptions): Promise<ReindexReport>;
	/** One row, after a write. A transform that gives `null` takes it out. */
	indexRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	/** The same, for rows a `createMany` or a `findMany` gave back. */
	indexRows(
		rows: readonly Row<TTable>[],
		options?: IndexWriteOptions,
	): Promise<void>;
	/**
	 * Takes a row out, by the index id `toIndexId` gives for it — for the row
	 * `delete` or `hardDelete` handed back. A `restore` puts a row back, so
	 * its row goes to `indexRow`.
	 */
	removeRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	/** Takes a document out by its index id, when the row itself is gone. */
	remove(id: IdOf<I>, options?: IndexWriteOptions): Promise<void>;
	/** The same, for several ids in one call. */
	removeMany(
		ids: readonly IdOf<I>[],
		options?: IndexWriteOptions,
	): Promise<void>;
}

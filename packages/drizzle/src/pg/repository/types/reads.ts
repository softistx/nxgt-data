import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PageOptions } from '../../../pagination/page';
import type { ColumnKey, Row } from './columns';

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
	withDeleted?: boolean | undefined;
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

import type { Row } from '@nxgt/drizzle/pg';
import type { AnyIndexDefinition, IdOf } from '@nxgt/meilisearch';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createContext } from './context';
import { reindex } from './reindex';
import type {
	IndexWriteOptions,
	ReindexOptions,
	ReindexReport,
	SearchSync,
	SearchSyncOptions,
} from './types';
import { idsOf, indexRows, removeIds } from './write';

/**
 * A table and an index, kept in step by the calls an application already
 * makes. Builds nothing and opens nothing: the repository and the index are
 * already bound.
 *
 * ```ts
 * const search = createSearchSync({
 *   repository: users,
 *   index: usersIndex,
 *   toIndexId: (row) => row.id,
 *   transform: (row) =>
 *     row.deletedAt ? null : { id: row.id, email: row.email, name: row.name },
 * });
 *
 * const user = await users.create({ email: 'ada@example.com' });
 * await search.indexRow(user);
 * ```
 *
 * `createSearchSync`, not `connect*`: `AGENTS.md` reserves `create*` for an
 * assembly that does no I/O, and nothing here talks to PostgreSQL or to
 * Meilisearch until a method is called.
 */
export function createSearchSync<
	TTable extends PgTable,
	I extends AnyIndexDefinition,
>(options: SearchSyncOptions<TTable, I>): SearchSync<TTable, I> {
	const ctx = createContext(
		options as unknown as SearchSyncOptions<PgTable, AnyIndexDefinition>,
	);
	const rowsOf = (rows: readonly Row<TTable>[]) =>
		rows as unknown as readonly Record<string, unknown>[];
	return {
		name: ctx.name,
		reindexAll: (opts?: ReindexOptions): Promise<ReindexReport> =>
			reindex(ctx, opts),
		indexRow: (row: Row<TTable>, opts?: IndexWriteOptions) =>
			indexRows(ctx, rowsOf([row]), opts),
		indexRows: (rows: readonly Row<TTable>[], opts?: IndexWriteOptions) =>
			indexRows(ctx, rowsOf(rows), opts),
		// `async`, so that a `toIndexId` which throws rejects like every other
		// failure here: `idsOf` runs before `removeIds` is even called, and a
		// synchronous throw would slip past a caller's `.catch`.
		removeRow: async (row: Row<TTable>, opts?: IndexWriteOptions) =>
			removeIds(ctx, idsOf(ctx, rowsOf([row])), opts),
		remove: (id: IdOf<I>, opts?: IndexWriteOptions) =>
			removeIds(ctx, [id], opts),
		removeMany: (ids: readonly IdOf<I>[], opts?: IndexWriteOptions) =>
			removeIds(ctx, ids, opts),
	};
}

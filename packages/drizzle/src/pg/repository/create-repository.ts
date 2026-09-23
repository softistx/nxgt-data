import type { PgTable } from 'drizzle-orm/pg-core';
import {
	type AnyRow,
	acting,
	createContext,
	type RepositoryContext,
	rebound,
} from './context';
import { paginate, paginateByCursor } from './operations/paginate';
import {
	countRows,
	exists,
	findById,
	findFirst,
	findMany,
	getById,
} from './operations/reads';
import {
	create,
	createMany,
	deleteMany,
	deleteOne,
	hardDelete,
	hardDeleteMany,
	restore,
	update,
	updateMany,
} from './operations/writes';
import { tableInfo } from './table-info';
import type {
	ColumnKey,
	CursorPaginateOptions,
	FindFirstOptions,
	FindManyOptions,
	HasColumn,
	LockOf,
	PaginateOptions,
	PgDatabase,
	PrimaryKeyOf,
	ReadOptions,
	Repository,
	RepositoryOptions,
} from './types';

/**
 * A repository over one table: typed reads and writes by id or by `where`,
 * pagination, soft delete, and database errors turned into `DataError`s.
 *
 * ```ts
 * const users = createRepository(db, usersTable);
 * const ada = await users.create({ email: 'ada@example.com' });
 * await users.update(ada.id, { name: 'Ada' });
 * ```
 */
export function createRepository<
	TTable extends PgTable,
	TKey extends ColumnKey<TTable> = PrimaryKeyOf<TTable>,
	TSoft extends boolean = HasColumn<TTable, 'deletedAt'>,
	TLock extends boolean = LockOf<TTable>,
>(
	db: PgDatabase,
	table: TTable,
	options: RepositoryOptions<TTable, TKey, TSoft, TLock> = {},
): Repository<TTable, TKey, TSoft, TLock> {
	const info = tableInfo(table, options);
	return build(
		createContext(db, table, info, options),
	) as unknown as Repository<TTable, TKey, TSoft, TLock>;
}

/**
 * The methods, bound to a context. Each one lives in a subject file —
 * `operations/reads.ts`, `operations/writes.ts`, `operations/paginate.ts`;
 * this is only the surface they are reached by.
 */
function build(ctx: RepositoryContext) {
	return {
		table: ctx.table,
		db: ctx.db,
		with: (other: PgDatabase) => build(rebound(ctx, other)),
		as: (actor: unknown) => build(acting(ctx, actor)),

		findById: (id: unknown, opts?: ReadOptions) => findById(ctx, id, opts),
		getById: (id: unknown, opts?: ReadOptions) => getById(ctx, id, opts),
		findFirst: (where?: unknown, opts?: FindFirstOptions<any>) =>
			findFirst(ctx, where, opts),
		findMany: (opts?: FindManyOptions<any>) => findMany(ctx, opts),

		create: (values: AnyRow) => create(ctx, values),
		createMany: (values: readonly AnyRow[]) => createMany(ctx, values),
		update: (id: unknown, patch: AnyRow) => update(ctx, id, patch),
		updateMany: (where: unknown, patch: AnyRow) =>
			updateMany(ctx, where, patch),

		delete: (id: unknown) => deleteOne(ctx, id),
		deleteMany: (where: unknown) => deleteMany(ctx, where),
		hardDelete: (id: unknown) => hardDelete(ctx, id),
		hardDeleteMany: (where: unknown) => hardDeleteMany(ctx, where),
		restore: (id: unknown) => restore(ctx, id),

		count: (where?: unknown, opts?: ReadOptions) => countRows(ctx, where, opts),
		exists: (where: unknown, opts?: ReadOptions) => exists(ctx, where, opts),
		paginate: (opts?: PaginateOptions<any>) => paginate(ctx, opts),
		paginateByCursor: (opts?: CursorPaginateOptions<any>) =>
			paginateByCursor(ctx, opts),
	};
}

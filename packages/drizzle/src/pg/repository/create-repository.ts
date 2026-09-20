import { and, asc, count, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ArgumentError } from '../../errors/argument-error';
import { InvalidCursorError, NotFoundError } from '../../errors/data-error';
import { toDataError } from '../../errors/to-data-error';
import { decodeCursor, encodeCursor } from '../../pagination/cursor';
import {
	type CursorPage,
	cursorLimit,
	DEFAULT_MAX_PAGE_SIZE,
	type Page,
	pageWindow,
	toPage,
} from '../../pagination/page';
import {
	columnAt,
	isEmptyWhere,
	keysetAfter,
	orderByToSql,
	whereToSql,
} from './conditions';
import { type TableInfo, tableInfo } from './table-info';
import type {
	ColumnKey,
	CursorPaginateOptions,
	FindFirstOptions,
	FindManyOptions,
	HasColumn,
	PaginateOptions,
	PgDatabase,
	PrimaryKeyOf,
	ReadOptions,
	Repository,
	RepositoryOptions,
} from './types';

type AnyRow = Record<string, unknown>;

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
>(
	db: PgDatabase,
	table: TTable,
	options: RepositoryOptions<TTable, TKey, TSoft> = {},
): Repository<TTable, TKey, TSoft> {
	const info = tableInfo(table, options);
	return build(db, table, info, options) as unknown as Repository<
		TTable,
		TKey,
		TSoft
	>;
}

function build(
	db: PgDatabase,
	table: PgTable,
	info: TableInfo,
	options: RepositoryOptions<any, any, any>,
) {
	// Drizzle's builders are typed per table; this body works on any table,
	// and the public type above is what callers see.
	const d = db as any;
	const t = table as any;
	const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

	async function run<R>(fn: () => Promise<R>): Promise<R> {
		try {
			return await fn();
		} catch (error) {
			throw toDataError(error);
		}
	}

	function primaryKey(): { key: string; column: PgColumn } {
		if ('error' in info.primaryKey) throw new TypeError(info.primaryKey.error);
		return info.primaryKey;
	}

	function byId(id: unknown): SQL {
		return eq(primaryKey().column, id);
	}

	function notFound(id: unknown): NotFoundError {
		return new NotFoundError(
			`No row in "${info.name}" with ${primaryKey().key} ${String(id)}`,
			{ table: info.name, id },
		);
	}

	function live(withDeleted?: boolean): SQL | undefined {
		return info.deletedAt && !withDeleted
			? isNull(info.deletedAt.column)
			: undefined;
	}

	function filter(where: unknown, withDeleted?: boolean): SQL | undefined {
		return and(whereToSql(info, where), live(withDeleted));
	}

	function requireWhere(method: string, where: unknown): void {
		if (isEmptyWhere(where)) {
			// An `ArgumentError` like the ones `conditions.ts` throws: a `where`
			// built from a request that comes out empty is the caller's input,
			// not the table's definition, so a handler answers 400 on it.
			throw new ArgumentError(
				'where',
				`${method} needs a where. Pass \`sql\`true\`\` to target every row of "${info.name}".`,
			);
		}
	}

	/** The patch, with `updatedAt = now()` unless it sets it or Drizzle will. */
	function touched(patch: AnyRow): AnyRow {
		const set: AnyRow = {};
		for (const [key, value] of Object.entries(patch)) {
			if (value !== undefined) set[key] = value;
		}
		const updatedAt = info.updatedAt;
		if (
			updatedAt &&
			!(updatedAt.key in set) &&
			!updatedAt.column.onUpdateFn &&
			Object.keys(set).length > 0
		) {
			set[updatedAt.key] = sql`now()`;
		}
		return set;
	}

	function select(where: unknown, withDeleted?: boolean) {
		return d.select().from(t).where(filter(where, withDeleted)).$dynamic();
	}

	function defaultOrder(): PgColumn[] {
		return 'error' in info.primaryKey ? [] : [info.primaryKey.column];
	}

	async function findMany(opts: FindManyOptions<any> = {}): Promise<AnyRow[]> {
		return run(async () => {
			const query = select(opts.where, opts.withDeleted);
			const orderBy = orderByToSql(info, opts.orderBy);
			if (orderBy.length > 0) query.orderBy(...orderBy);
			if (opts.limit !== undefined) query.limit(opts.limit);
			if (opts.offset !== undefined) query.offset(opts.offset);
			return query;
		});
	}

	async function findById(id: unknown, opts: ReadOptions = {}) {
		return run(async () => {
			const rows = await select(undefined, opts.withDeleted)
				.where(and(byId(id), live(opts.withDeleted)))
				.limit(1);
			return rows[0] as AnyRow | undefined;
		});
	}

	async function getById(id: unknown, opts: ReadOptions = {}) {
		const row = await findById(id, opts);
		if (!row) throw notFound(id);
		return row;
	}

	async function countRows(where?: unknown, opts: ReadOptions = {}) {
		return run(async () => {
			const rows = await d
				.select({ total: count() })
				.from(t)
				.where(filter(where, opts.withDeleted));
			return (rows[0]?.total as number | undefined) ?? 0;
		});
	}

	async function update(id: unknown, patch: AnyRow) {
		const set = touched(patch);
		if (Object.keys(set).length === 0) return getById(id);
		return run(async () => {
			const rows = await d
				.update(t)
				.set(set)
				.where(and(byId(id), live()))
				.returning();
			if (!rows[0]) throw notFound(id);
			return rows[0] as AnyRow;
		});
	}

	async function hardDelete(id: unknown) {
		return run(async () => {
			const rows = await d.delete(t).where(byId(id)).returning();
			if (!rows[0]) throw notFound(id);
			return rows[0] as AnyRow;
		});
	}

	async function hardDeleteMany(where: unknown) {
		requireWhere('hardDeleteMany', where);
		return run(async () =>
			d.delete(t).where(whereToSql(info, where)).returning(),
		);
	}

	const repository = {
		table,
		db,
		with: (other: PgDatabase) => build(other, table, info, options),

		findById,
		getById,

		async findFirst(where?: unknown, opts: FindFirstOptions<any> = {}) {
			const rows = await findMany({
				...opts,
				where: where as FindManyOptions<any>['where'],
				limit: 1,
			});
			return rows[0];
		},

		findMany,

		async create(values: AnyRow) {
			return run(async () => {
				const rows = await d.insert(t).values(values).returning();
				return rows[0] as AnyRow;
			});
		},

		async createMany(values: readonly AnyRow[]) {
			if (values.length === 0) return [];
			return run(async () =>
				d
					.insert(t)
					.values([...values])
					.returning(),
			);
		},

		update,

		async updateMany(where: unknown, patch: AnyRow) {
			requireWhere('updateMany', where);
			const set = touched(patch);
			if (Object.keys(set).length === 0) {
				return findMany({ where: where as FindManyOptions<any>['where'] });
			}
			return run(async () =>
				d.update(t).set(set).where(filter(where)).returning(),
			);
		},

		async delete(id: unknown) {
			const deletedAt = info.deletedAt;
			if (!deletedAt) return hardDelete(id);
			return run(async () => {
				const rows = await d
					.update(t)
					.set(touched({ [deletedAt.key]: sql`now()` }))
					.where(and(byId(id), live()))
					.returning();
				if (!rows[0]) throw notFound(id);
				return rows[0] as AnyRow;
			});
		},

		async deleteMany(where: unknown) {
			requireWhere('deleteMany', where);
			const deletedAt = info.deletedAt;
			if (!deletedAt) return hardDeleteMany(where);
			return run(async () =>
				d
					.update(t)
					.set(touched({ [deletedAt.key]: sql`now()` }))
					.where(filter(where))
					.returning(),
			);
		},

		hardDelete,
		hardDeleteMany,

		async restore(id: unknown) {
			const deletedAt = info.deletedAt;
			if (!deletedAt) {
				throw new TypeError(`restore: "${info.name}" has no soft delete`);
			}
			return run(async () => {
				const rows = await d
					.update(t)
					.set(touched({ [deletedAt.key]: null }))
					.where(byId(id))
					.returning();
				if (!rows[0]) throw notFound(id);
				return rows[0] as AnyRow;
			});
		},

		count: countRows,

		async exists(where: unknown, opts: ReadOptions = {}) {
			return run(async () => {
				const rows = await d
					.select({ one: sql`1` })
					.from(t)
					.where(filter(where, opts.withDeleted))
					.limit(1);
				return rows.length > 0;
			});
		},

		async paginate(opts: PaginateOptions<any> = {}): Promise<Page<AnyRow>> {
			const window = pageWindow(opts, maxPageSize);
			const [items, total] = await Promise.all([
				findMany({
					where: opts.where,
					orderBy: opts.orderBy ?? defaultOrder(),
					limit: window.limit,
					offset: window.offset,
					withDeleted: opts.withDeleted,
				}),
				countRows(opts.where, opts),
			]);
			return toPage(items, total, window);
		},

		async paginateByCursor(
			opts: CursorPaginateOptions<any> = {},
		): Promise<CursorPage<AnyRow>> {
			const pk = primaryKey();
			const sortKey = opts.orderBy ?? pk.key;
			const direction = opts.direction ?? 'asc';
			const keys = sortKey === pk.key ? [pk.key] : [sortKey, pk.key];
			const columns = keys.map((key) =>
				columnAt(info, key, 'paginateByCursor'),
			);
			const cursorKey = `${sortKey}:${direction}`;
			const limit = cursorLimit(opts.limit, maxPageSize);

			let after: SQL | undefined;
			if (opts.after) {
				const { values } = decodeCursor(opts.after, cursorKey);
				if (values.length !== keys.length) {
					throw new InvalidCursorError(
						`Invalid cursor: expected ${keys.length} value(s), got ${values.length}`,
					);
				}
				after = keysetAfter(columns, values, direction);
			}

			const rows: AnyRow[] = await run(async () =>
				d
					.select()
					.from(t)
					.where(and(filter(opts.where, opts.withDeleted), after))
					.orderBy(
						...columns.map((c) => (direction === 'asc' ? asc(c) : desc(c))),
					)
					.limit(limit + 1),
			);
			const items = rows.slice(0, limit);
			const last = items.at(-1);
			if (rows.length <= limit || !last) return { items, nextCursor: null };

			const values = keys.map((key) => {
				const value = last[key];
				if (value === null || value === undefined) {
					throw new TypeError(
						`paginateByCursor: "${key}" is null in a row of "${info.name}". ` +
							'Page along a NOT NULL column.',
					);
				}
				return value;
			});
			return { items, nextCursor: encodeCursor({ key: cursorKey, values }) };
		},
	};

	return repository;
}

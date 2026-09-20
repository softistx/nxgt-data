import { and, asc, desc, type SQL } from 'drizzle-orm';
import { InvalidCursorError } from '../../../errors/data-error';
import { decodeCursor, encodeCursor } from '../../../pagination/cursor';
import {
	type CursorPage,
	cursorLimit,
	type Page,
	pageWindow,
	toPage,
} from '../../../pagination/page';
import { columnAt, keysetAfter } from '../conditions';
import {
	type AnyRow,
	builders,
	primaryKey,
	type RepositoryContext,
	run,
} from '../context';
import { defaultOrder, scoped } from '../filters';
import type { CursorPaginateOptions, PaginateOptions } from '../types';
import { countRows, findMany } from './reads';

export async function paginate(
	ctx: RepositoryContext,
	opts: PaginateOptions<any> = {},
): Promise<Page<AnyRow>> {
	const window = pageWindow(
		opts,
		ctx.maxPageSize,
		`paginate on "${ctx.info.name}"`,
	);
	const [items, total] = await Promise.all([
		findMany(ctx, {
			where: opts.where,
			orderBy: opts.orderBy ?? defaultOrder(ctx),
			limit: window.limit,
			offset: window.offset,
			withDeleted: opts.withDeleted,
		}),
		countRows(ctx, opts.where, opts),
	]);
	return toPage(items, total, window);
}

export async function paginateByCursor(
	ctx: RepositoryContext,
	opts: CursorPaginateOptions<any> = {},
): Promise<CursorPage<AnyRow>> {
	const pk = primaryKey(ctx);
	const sortKey = opts.orderBy ?? pk.key;
	const direction = opts.direction ?? 'asc';
	// The primary key breaks ties, so two rows that sort the same still have
	// one order and a cursor lands between them rather than on both.
	const keys = sortKey === pk.key ? [pk.key] : [sortKey, pk.key];
	const columns = keys.map((key) =>
		columnAt(ctx.info, key, 'paginateByCursor'),
	);
	const cursorKey = `${sortKey}:${direction}`;
	const limit = cursorLimit(
		opts.limit,
		ctx.maxPageSize,
		`paginateByCursor on "${ctx.info.name}"`,
	);

	let after: SQL | undefined;
	if (opts.after) {
		const where = `paginateByCursor on "${ctx.info.name}"`;
		const { values } = decodeCursor(
			opts.after,
			cursorKey,
			where,
			ctx.info.name,
		);
		if (values.length !== keys.length) {
			throw new InvalidCursorError(
				`Invalid cursor in ${where}: it holds ${values.length} ` +
					`value(s) where the ordering ${cursorKey} needs ` +
					`${keys.length} (${keys.join(', ')})`,
				{ table: ctx.info.name },
			);
		}
		after = keysetAfter(columns, values, direction);
	}

	// One row more than asked for: whether it came back is how the next cursor
	// is decided, without a second query counting what is left.
	const rows: AnyRow[] = await run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d
			.select()
			.from(t)
			.where(and(scoped(ctx, opts.where, opts.withDeleted), after))
			.orderBy(...columns.map((c) => (direction === 'asc' ? asc(c) : desc(c))))
			.limit(limit + 1);
	});
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	if (rows.length <= limit || !last) return { items, nextCursor: null };

	const values = keys.map((key) => {
		const value = last[key];
		if (value === null || value === undefined) {
			throw new TypeError(
				`paginateByCursor: "${key}" is null in a row of "${ctx.info.name}". ` +
					'Page along a NOT NULL column.',
			);
		}
		return value;
	});
	return { items, nextCursor: encodeCursor({ key: cursorKey, values }) };
}

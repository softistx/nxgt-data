import { and, count, sql } from 'drizzle-orm';
import { orderByToSql } from '../conditions';
import {
	type AnyRow,
	builders,
	notFound,
	type RepositoryContext,
	run,
} from '../context';
import { byId, live, scoped } from '../filters';
import type { FindFirstOptions, FindManyOptions, ReadOptions } from '../types';

/**
 * A dynamic `SELECT *` over the table, scoped to the rows the caller can see.
 *
 * `$dynamic()` is what lets the callers below add `orderBy`, `limit` and
 * `offset` one at a time instead of building every combination up front.
 */
function select(ctx: RepositoryContext, where: unknown, withDeleted?: boolean) {
	const { d, t } = builders(ctx);
	return d
		.select()
		.from(t)
		.where(scoped(ctx, where, withDeleted))
		.$dynamic();
}

export async function findMany(
	ctx: RepositoryContext,
	opts: FindManyOptions<any> = {},
): Promise<AnyRow[]> {
	return run(ctx, async () => {
		const query = select(ctx, opts.where, opts.withDeleted);
		const orderBy = orderByToSql(ctx.info, opts.orderBy);
		if (orderBy.length > 0) query.orderBy(...orderBy);
		if (opts.limit !== undefined) query.limit(opts.limit);
		if (opts.offset !== undefined) query.offset(opts.offset);
		return query;
	});
}

export async function findById(
	ctx: RepositoryContext,
	id: unknown,
	opts: ReadOptions = {},
): Promise<AnyRow | undefined> {
	return run(ctx, async () => {
		const rows = await select(ctx, undefined, opts.withDeleted)
			.where(and(byId(ctx, id), live(ctx, opts.withDeleted)))
			.limit(1);
		return rows[0] as AnyRow | undefined;
	});
}

export async function getById(
	ctx: RepositoryContext,
	id: unknown,
	opts: ReadOptions = {},
): Promise<AnyRow> {
	const row = await findById(ctx, id, opts);
	if (!row) throw notFound(ctx, id);
	return row;
}

export async function findFirst(
	ctx: RepositoryContext,
	where?: unknown,
	opts: FindFirstOptions<any> = {},
): Promise<AnyRow | undefined> {
	const rows = await findMany(ctx, {
		...opts,
		where: where as FindManyOptions<any>['where'],
		limit: 1,
	});
	return rows[0];
}

export async function countRows(
	ctx: RepositoryContext,
	where?: unknown,
	opts: ReadOptions = {},
): Promise<number> {
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d
			.select({ total: count() })
			.from(t)
			.where(scoped(ctx, where, opts.withDeleted));
		return (rows[0]?.total as number | undefined) ?? 0;
	});
}

export async function exists(
	ctx: RepositoryContext,
	where: unknown,
	opts: ReadOptions = {},
): Promise<boolean> {
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d
			.select({ one: sql`1` })
			.from(t)
			.where(scoped(ctx, where, opts.withDeleted))
			.limit(1);
		return rows.length > 0;
	});
}

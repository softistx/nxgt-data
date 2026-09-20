import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ArgumentError } from '../../errors/argument-error';
import { isEmptyWhere, whereToSql } from './conditions';
import { primaryKey, type RepositoryContext } from './context';

/** `id = <id>`, on the column the table is addressed by. */
export function byId(ctx: RepositoryContext, id: unknown): SQL {
	return eq(primaryKey(ctx).column, id);
}

/** The condition that leaves soft-deleted rows out, when there are any. */
export function live(
	ctx: RepositoryContext,
	withDeleted?: boolean,
): SQL | undefined {
	return ctx.info.deletedAt && !withDeleted
		? isNull(ctx.info.deletedAt.column)
		: undefined;
}

/** A caller's `where`, scoped to the rows they can see. */
export function scoped(
	ctx: RepositoryContext,
	where: unknown,
	withDeleted?: boolean,
): SQL | undefined {
	return and(whereToSql(ctx.info, where), live(ctx, withDeleted));
}

/**
 * Refuses a bulk write with nothing to match on.
 *
 * An `ArgumentError` like the ones `conditions.ts` throws: a `where` built
 * from a request that comes out empty is the caller's input, not the table's
 * definition, so a handler answers 400 on it.
 */
export function requireWhere(
	ctx: RepositoryContext,
	method: string,
	where: unknown,
): void {
	if (isEmptyWhere(where)) {
		throw new ArgumentError(
			'where',
			`${method} needs a where. Pass \`sql\`true\`\` to target every row of "${ctx.info.name}".`,
		);
	}
}

/**
 * What a page is ordered by when the caller says nothing: the primary key, or
 * nothing at all on a table that has no single one.
 *
 * It does not throw the way `primaryKey` does — an unordered page is a page,
 * and refusing one here would take `paginate` away from a table that is
 * perfectly readable.
 */
export function defaultOrder(ctx: RepositoryContext): PgColumn[] {
	const pk = ctx.info.primaryKey;
	return 'error' in pk ? [] : [pk.column];
}

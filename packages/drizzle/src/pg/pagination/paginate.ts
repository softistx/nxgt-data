import { count } from 'drizzle-orm';
import { toDataError } from '../../errors/to-data-error';
import {
	DEFAULT_MAX_PAGE_SIZE,
	type Page,
	type PageOptions,
	pageWindow,
	toPage,
} from '../../pagination/page';
import type { PgDatabase } from '../repository/types';

/**
 * What `paginate` needs of a query: a Drizzle select that can still take a
 * `limit` and an `offset`, and be used as a subquery to be counted.
 */
export interface PaginatableQuery<TRow> {
	limit(limit: number): { offset(offset: number): PromiseLike<TRow[]> };
	as(alias: string): unknown;
}

export interface PaginateQueryOptions extends PageOptions {
	/** The largest `pageSize` a page may ask for. Default `100`. */
	maxPageSize?: number;
	/**
	 * What to call this page in a refusal: `listInvoices`, `searchOrders`.
	 *
	 * Default `paginate`, which is honest and says little — this one pages an
	 * arbitrary select, so it is the paginated call most likely to appear
	 * many times in one application, and the one where `page must be an
	 * integer of at least 1` on its own says least. There is no table to name
	 * here the way a repository names its own, so the caller names it.
	 */
	name?: string;
}

/**
 * One page of any select, joins and all, and how many rows it has in total.
 * The total is `count(*)` over the query as a subquery.
 *
 * ```ts
 * const page = await paginate(
 *   db,
 *   db.select().from(users).where(eq(users.teamId, 1)).orderBy(users.id),
 *   { page: 2, pageSize: 20 },
 * );
 * ```
 */
export async function paginate<TRow>(
	db: PgDatabase,
	query: PaginatableQuery<TRow>,
	options: PaginateQueryOptions = {},
): Promise<Page<TRow>> {
	const window = pageWindow(
		options,
		options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
		options.name ?? 'paginate',
	);
	try {
		// Counted first: `limit` on a dynamic query changes the query itself,
		// and the count must not see it.
		const [counted] = await db
			.select({ total: count() })
			.from(query.as('nxgt_paginate') as any);
		const items = await query.limit(window.limit).offset(window.offset);
		return toPage(items, counted?.total ?? 0, window);
	} catch (error) {
		throw toDataError(error);
	}
}

/** One page of an offset pagination. */
export interface Page<T> {
	items: T[];
	/** Every document that matches, across all pages. */
	total: number;
	/** 1-based. */
	page: number;
	pageSize: number;
	/** `Math.ceil(total / pageSize)`: 0 when nothing matches. */
	pageCount: number;
}

/** One page of a cursor pagination. */
export interface CursorPage<T> {
	items: T[];
	/** Pass it as `after` for the next page; `null` on the last one. */
	nextCursor: string | null;
}

export interface PageOptions {
	/** 1-based. Default `1`. */
	page?: number;
	/** Default `20`, at most `maxPageSize`. */
	pageSize?: number;
}

export interface PageWindow {
	page: number;
	pageSize: number;
	limit: number;
	skip: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;

/**
 * Checks one pagination number and gives it back.
 *
 * `where` names the call it came from — `paginate on "users"` — because a
 * `RangeError` reading only `pageSize must be an integer of at least 1` says
 * nothing about which of an application's paginated calls produced it, and
 * every one of them takes the same two option names. It is optional:
 * `pageWindow` and `cursorLimit` are exported for a caller paginating
 * something this package knows nothing about.
 *
 * Exported so the bucket's own `paginateFiles` refuses a `limit` with this
 * sentence rather than a second copy of it. It does not take a maximum: a
 * bucket has no `maxPageSize`, and giving it one here would cap a listing
 * that is uncapped today.
 */
export function pageNumber(
	name: string,
	value: number,
	where?: string,
): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(
			`${where ? `${where}: ` : ''}${name} must be an integer of at ` +
				`least 1, not ${value}`,
		);
	}
	return value;
}

/**
 * Checks `page` and `pageSize` and turns them into a `limit` and a `skip`.
 * A `pageSize` above `maxPageSize` is lowered to it; one that is not a
 * positive integer throws a `RangeError`.
 */
export function pageWindow(
	options: PageOptions = {},
	maxPageSize = DEFAULT_MAX_PAGE_SIZE,
	where?: string,
): PageWindow {
	const page = pageNumber('page', options.page ?? 1, where);
	const pageSize = Math.min(
		pageNumber('pageSize', options.pageSize ?? DEFAULT_PAGE_SIZE, where),
		maxPageSize,
	);
	return { page, pageSize, limit: pageSize, skip: (page - 1) * pageSize };
}

/** Assembles a `Page` from its documents and the total. */
export function toPage<T>(
	items: T[],
	total: number,
	window: PageWindow,
): Page<T> {
	return {
		items,
		total,
		page: window.page,
		pageSize: window.pageSize,
		pageCount: Math.ceil(total / window.pageSize),
	};
}

/** Checks a cursor page's `limit`, as `pageWindow` checks a `pageSize`. */
export function cursorLimit(
	limit: number | undefined,
	maxPageSize = DEFAULT_MAX_PAGE_SIZE,
	where?: string,
): number {
	return Math.min(
		pageNumber('limit', limit ?? DEFAULT_PAGE_SIZE, where),
		maxPageSize,
	);
}

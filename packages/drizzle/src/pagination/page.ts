/** One page of an offset pagination. */
export interface Page<T> {
	items: T[];
	/** Every row that matches, across all pages. */
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
	offset: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;

function positiveInteger(name: string, value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(
			`${name} must be an integer of at least 1, not ${value}`,
		);
	}
	return value;
}

/**
 * Checks `page` and `pageSize` and turns them into a `limit` and an `offset`.
 * A `pageSize` above `maxPageSize` is lowered to it; one that is not a
 * positive integer throws a `RangeError`.
 */
export function pageWindow(
	options: PageOptions = {},
	maxPageSize = DEFAULT_MAX_PAGE_SIZE,
): PageWindow {
	const page = positiveInteger('page', options.page ?? 1);
	const pageSize = Math.min(
		positiveInteger('pageSize', options.pageSize ?? DEFAULT_PAGE_SIZE),
		maxPageSize,
	);
	return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/** Assembles a `Page` from its rows and the total. */
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
): number {
	return Math.min(
		positiveInteger('limit', limit ?? DEFAULT_PAGE_SIZE),
		maxPageSize,
	);
}

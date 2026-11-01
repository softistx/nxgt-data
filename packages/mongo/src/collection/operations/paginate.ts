import { InvalidCursorError } from '../../errors/data-error';
import { cursorKey, decodeCursor, encodeCursor } from '../../pagination/cursor';
import {
	type CursorPage,
	cursorLimit,
	type Page,
	pageWindow,
	toPage,
} from '../../pagination/page';
import type { CollectionContext } from '../context';
import { type Fields, isRecord, mergeFilters } from '../filters';
import type { OrderDirection } from '../types';
import { countDocuments, findMany } from './reads';

export async function paginate(
	ctx: CollectionContext,
	opts: Fields = {},
): Promise<Page<Fields>> {
	const window = pageWindow(opts, ctx.maxPageSize, `paginate on "${ctx.name}"`);
	const [items, total] = await Promise.all([
		findMany(ctx, {
			filter: opts['filter'],
			sort: opts['sort'] ?? { _id: 1 },
			limit: window.limit,
			skip: window.skip,
			withDeleted: opts['withDeleted'],
		}),
		countDocuments(ctx, opts['filter'], {
			withDeleted: opts['withDeleted'] as boolean | undefined,
		}),
	]);
	return toPage(items, total, window);
}

/**
 * The filter of the documents after a cursor: `a > x OR (a = x AND b > y)`.
 * MongoDB sorts null and missing values together, before every other value
 * (after them when descending), and range operators never match them, so the
 * null side of the leading field is spelled out. Only the leading field can
 * be null: `_id`, the tiebreaker, never is. `{ a: null }` matches a null and
 * a missing `a` alike, as the sort treats them.
 */
function keyset(
	fields: string[],
	values: readonly unknown[],
	past: '$gt' | '$lt',
	direction: OrderDirection,
): Fields {
	const [lead, ...rest] = fields as [string, ...string[]];
	const leadValue = values[0] ?? null;
	const clauses: Fields[] = [];
	if (leadValue !== null) {
		clauses.push({ [lead]: { [past]: leadValue } });
		// Descending, nulls come last: they follow every non-null value.
		if (direction === 'desc') clauses.push({ [lead]: null });
	} else if (direction === 'asc') {
		// Ascending, nulls come first: every non-null value follows one.
		clauses.push({ [lead]: { $ne: null } });
	}
	rest.forEach((field, i) => {
		clauses.push({ [lead]: leadValue, [field]: { [past]: values[i + 1] } });
	});
	return { $or: clauses };
}

/** The value at a dotted path, `undefined` when anything on the way is not an object. */
function valueAt(document: Fields, path: string): unknown {
	if (path in document) return document[path];
	let current: unknown = document;
	for (const part of path.split('.')) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

export async function paginateByCursor(
	ctx: CollectionContext,
	opts: Fields = {},
): Promise<CursorPage<Fields>> {
	const sortField = (opts['orderBy'] as string | undefined) ?? '_id';
	const head = sortField.split('.', 1)[0] as string;
	if (!ctx.shape[head] && head !== '_id') {
		throw new TypeError(
			`paginateByCursor: "${ctx.name}" has no field "${sortField}" in its schema`,
		);
	}
	const direction = (opts['direction'] as OrderDirection | undefined) ?? 'asc';
	const fields = sortField === '_id' ? ['_id'] : [sortField, '_id'];
	const own = opts['scope'];
	const scope = own === undefined ? ctx.cursorScope : own;
	if (scope !== undefined && typeof scope !== 'string') {
		throw new TypeError(
			`paginateByCursor: "scope" of "${ctx.name}" must be a string, ` +
				`not ${scope === null ? 'null' : typeof scope}`,
		);
	}
	const key = cursorKey(`${sortField}:${direction}`, scope);
	const limit = cursorLimit(
		opts['limit'] as number | undefined,
		ctx.maxPageSize,
		`paginateByCursor on "${ctx.name}"`,
	);
	const past = direction === 'asc' ? '$gt' : '$lt';

	let after: Fields | undefined;
	if (opts['after']) {
		const where = `paginateByCursor on "${ctx.name}"`;
		const { values } = decodeCursor(
			opts['after'] as string,
			key,
			where,
			ctx.name,
		);
		if (values.length !== fields.length) {
			// `InvalidCursorError`, like every other refusal of a cursor: this
			// one was a bare `DataError` with `code: 'DATABASE'`, so a handler
			// answering 400 on `INVALID_CURSOR` answered 500 to the one cursor
			// failure a client can cause by pasting the wrong page's link.
			throw new InvalidCursorError(
				`Invalid cursor in ${where}: it holds ${values.length} value(s) ` +
					`where the ordering ${sortField}:${direction} needs ${fields.length} ` +
					`(${fields.join(', ')})`,
				{ collection: ctx.name },
			);
		}
		after = keyset(fields, values, past, direction);
	}

	const sort = Object.fromEntries(
		fields.map((field) => [field, direction === 'asc' ? 1 : -1]),
	);
	const documents = await findMany(ctx, {
		filter: mergeFilters(
			isRecord(opts['filter']) ? opts['filter'] : undefined,
			after,
		),
		sort,
		limit: limit + 1,
		withDeleted: opts['withDeleted'],
	});

	const items = documents.slice(0, limit);
	const last = items.at(-1);
	if (documents.length <= limit || !last) {
		return { items, nextCursor: null };
	}

	// A null or missing value is kept as `null`: MongoDB sorts both first
	// ascending, last descending, and `keyset` resumes from there.
	const values = fields.map((field) => valueAt(last, field) ?? null);
	return { items, nextCursor: encodeCursor({ key, values }) };
}

import { DataError } from '../errors/data-error';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import {
	type CursorPage,
	cursorLimit,
	type Page,
	pageWindow,
	toPage,
} from '../pagination/page';
import type { CollectionContext } from './context';
import { type Fields, isRecord, mergeFilters } from './filters';
import { countDocuments, findMany } from './reads';
import type { OrderDirection } from './types';

export async function paginate(
	ctx: CollectionContext,
	opts: Fields = {},
): Promise<Page<Fields>> {
	const window = pageWindow(opts, ctx.maxPageSize);
	const [items, total] = await Promise.all([
		findMany(ctx, {
			filter: opts.filter,
			sort: opts.sort ?? { _id: 1 },
			limit: window.limit,
			skip: window.skip,
			withDeleted: opts.withDeleted,
		}),
		countDocuments(ctx, opts.filter, {
			withDeleted: opts.withDeleted as boolean | undefined,
		}),
	]);
	return toPage(items, total, window);
}

export async function paginateByCursor(
	ctx: CollectionContext,
	opts: Fields = {},
): Promise<CursorPage<Fields>> {
	const sortField = (opts.orderBy as string | undefined) ?? '_id';
	if (!ctx.shape[sortField] && sortField !== '_id') {
		throw new TypeError(
			`paginateByCursor: "${ctx.name}" has no field "${sortField}" in its schema`,
		);
	}
	const direction = (opts.direction as OrderDirection | undefined) ?? 'asc';
	const fields = sortField === '_id' ? ['_id'] : [sortField, '_id'];
	const cursorKey = `${sortField}:${direction}`;
	const limit = cursorLimit(opts.limit as number | undefined, ctx.maxPageSize);
	const past = direction === 'asc' ? '$gt' : '$lt';

	let after: Fields | undefined;
	if (opts.after) {
		const { values } = decodeCursor(opts.after as string, cursorKey);
		if (values.length !== fields.length) {
			throw new DataError(
				`Invalid cursor: expected ${fields.length} value(s), got ${values.length}`,
				{ collection: ctx.name },
			);
		}
		// `a > x OR (a = x AND b > y)`, the keyset of the ordering.
		after = {
			$or: fields.map((field, index) => ({
				...Object.fromEntries(
					fields.slice(0, index).map((previous, i) => [previous, values[i]]),
				),
				[field]: { [past]: values[index] },
			})),
		};
	}

	const sort = Object.fromEntries(
		fields.map((field) => [field, direction === 'asc' ? 1 : -1]),
	);
	const documents = await findMany(ctx, {
		filter: mergeFilters(
			isRecord(opts.filter) ? opts.filter : undefined,
			after,
		),
		sort,
		limit: limit + 1,
		withDeleted: opts.withDeleted,
	});

	const items = documents.slice(0, limit);
	const last = items.at(-1);
	if (documents.length <= limit || !last) {
		return { items, nextCursor: null };
	}

	const values = fields.map((field) => {
		const value = last[field];
		if (value === null || value === undefined) {
			throw new TypeError(
				`paginateByCursor: "${field}" is null in a document of "${ctx.name}". ` +
					'Page along a field every document has.',
			);
		}
		return value;
	});
	return { items, nextCursor: encodeCursor({ key: cursorKey, values }) };
}

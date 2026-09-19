import type { Document, Filter, ObjectId, Sort } from 'mongodb';
import { coerceFilter } from '../../collection/coerce';
import { decodeCursor, encodeCursor } from '../../pagination/cursor';
import type { CursorPage } from '../../pagination/page';
import { type BucketContext, run } from '../context';
import { FileHandle, type StoredFile } from '../handle';

export interface FilePageOptions {
	/**
	 * A filter on the `files` documents, with the metadata under `metadata.`:
	 * `{ 'metadata.userId': '68ca…' }` reads the string as the id it is.
	 */
	filter?: Filter<Document>;
	/** Default `20`. */
	limit?: number;
	/** The `nextCursor` of the previous page. Omit it for the first one. */
	after?: string | null;
	/** Newest first by default, which is what a file listing almost always wants. */
	order?: 'newest' | 'oldest';
}

/** The ordering: `uploadDate` is not unique, so `_id` settles the ties. */
const KEY = { newest: 'uploadDate:desc', oldest: 'uploadDate:asc' } as const;

/**
 * One page of the bucket, in the same cursor shape as everything else here.
 *
 * A file listing is paged on `uploadDate` and `_id` together: two files
 * uploaded in the same millisecond would otherwise share a cursor position,
 * and one of them would never be read.
 */
export async function paginateFiles(
	ctx: BucketContext,
	options: FilePageOptions = {},
): Promise<CursorPage<FileHandle>> {
	const order = options.order ?? 'newest';
	const key = KEY[order];
	const limit = options.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(
			`limit must be an integer of at least 1, not ${limit}`,
		);
	}
	const given = (options.filter ?? {}) as Document;
	const filter: Document = ctx.coerces
		? coerceFilter(metadataKinds(ctx), given)
		: { ...given };
	if (options.after) {
		const { values } = decodeCursor(options.after, key);
		const [date, id] = values as [Date, ObjectId];
		const after = order === 'newest' ? '$lt' : '$gt';
		// A compound `$or` rather than `$lt` on a pair: MongoDB compares
		// documents field by field, and an index on `{ uploadDate, _id }` is
		// only used when the comparison is written out this way.
		filter.$and = [
			...(Array.isArray(filter.$and) ? filter.$and : []),
			{
				$or: [
					{ uploadDate: { [after]: date } },
					{ uploadDate: date, _id: { [after]: id } },
				],
			},
		];
	}
	const direction = order === 'newest' ? -1 : 1;
	const sort = { uploadDate: direction, _id: direction } as Sort;
	const found = await run(ctx, () =>
		ctx.files
			.find<StoredFile>(filter, ctx.sessionOption)
			.sort(sort)
			.limit(limit + 1)
			.toArray(),
	);
	const page = found.slice(0, limit);
	const items = page.map((stored) => new FileHandle(ctx, stored));
	const last = page.at(-1);
	if (found.length <= limit || !last) return { items, nextCursor: null };
	return {
		items,
		nextCursor: encodeCursor({ key, values: [last.uploadDate, last._id] }),
	};
}

/**
 * The metadata's coercible fields, under the `metadata.` prefix a filter on
 * the `files` collection has to use.
 */
function metadataKinds(ctx: BucketContext) {
	const kinds: Record<string, 'objectId' | 'date'> = {
		_id: 'objectId',
		uploadDate: 'date',
	};
	for (const [path, kind] of Object.entries(ctx.kinds)) {
		kinds[`metadata.${path}`] = kind;
	}
	return kinds;
}

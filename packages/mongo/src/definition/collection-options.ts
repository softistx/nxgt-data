import type { CollationOptions, CreateCollectionOptions } from 'mongodb';

/**
 * A capped collection: a fixed-size ring that drops its oldest documents.
 *
 * `size` is not optional, because MongoDB refuses the collection without it —
 * `createCollection` answers "the 'size' field is required when 'capped' is
 * true". Requiring it here turns that into a compile error.
 */
export interface CappedOption {
	/** The cap, in bytes. */
	size: number;
	/** And at most this many documents, on top of the size cap. */
	max?: number;
}

/** How MongoDB buckets a time series. */
export type TimeseriesGranularity = 'seconds' | 'minutes' | 'hours';

/**
 * A time-series collection, keyed on fields of the schema.
 *
 * `timeField` and `metaField` are fixed once the collection exists; the
 * granularity and the bucket spans can still be changed afterwards.
 */
export interface TimeseriesOption<Field extends string = string> {
	/** The field holding each document's date. */
	timeField: Field;
	/** The field holding the labels a series is grouped by. */
	metaField?: Field;
	granularity?: TimeseriesGranularity;
	bucketMaxSpanSeconds?: number;
	bucketRoundingSeconds?: number;
}

/**
 * A clustered collection, stored in `_id` order.
 *
 * MongoDB clusters on `_id` and nothing else, and the index is always unique:
 * both are spelled out here rather than left open and refused by the server.
 */
export interface ClusteredIndexOption {
	key: { _id: 1 };
	unique: true;
	name?: string;
}

/**
 * MongoDB's own options for a collection, as `defineCollection` takes them.
 *
 * Most of them are fixed when the collection is created — `sync` cannot change
 * a collation, or make an existing collection capped — so it refuses to
 * pretend otherwise: a definition that disagrees with the live collection on
 * one of those throws, naming the option, rather than sync silently doing
 * nothing. See `diffCollectionOptions` for which ones can still be changed.
 */
export interface MongoCollectionOptions<Field extends string = string> {
	/** A fixed-size ring, oldest documents first. */
	capped?: CappedOption;
	/** A time-series collection, keyed on a field of the schema. */
	timeseries?: TimeseriesOption<Field>;
	/**
	 * Seconds after which a document expires. MongoDB accepts it on a
	 * time-series collection; elsewhere a TTL is an index option.
	 */
	expireAfterSeconds?: number;
	/** The default collation of every query and index that does not name one. */
	collation?: CollationOptions;
	/** Store the documents in `_id` order, with no separate `_id` index. */
	clusteredIndex?: ClusteredIndexOption;
	/** Keep the document as it was before a change, for `watch()` to give back. */
	changeStreamPreAndPostImages?: { enabled: boolean };
}

/**
 * The options as `createCollection` takes them: `capped` is one object here
 * and three sibling keys there, which is the only shape difference.
 */
export function creationOptionsOf(
	options: MongoCollectionOptions,
): CreateCollectionOptions {
	const { capped, ...rest } = options;
	return {
		...(rest as CreateCollectionOptions),
		...(capped
			? {
					capped: true,
					size: capped.size,
					...(capped.max === undefined ? {} : { max: capped.max }),
				}
			: {}),
	};
}

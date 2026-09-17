import type {
	AnyIndexDefinition,
	DocumentOf as IndexDocumentOf,
	IdOf as IndexIdOf,
	TypedIndex,
} from '@nxgt/meilisearch';
import type {
	AnyCollectionDefinition,
	CloseReason,
	IdOf as CollectionIdOf,
	ReadDocumentOf,
	ResumeToken,
	TypedCollection,
} from '@nxgt/mongo';

/**
 * What a document of the collection becomes in the index: a document, or
 * `null` to keep it out — and take it out, if it was in.
 */
export type Transform<
	C extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
> = (
	document: ReadDocumentOf<C>,
) => IndexDocumentOf<I> | null | Promise<IndexDocumentOf<I> | null>;

/** The index id of a collection's `_id`. */
export type ToIndexId<
	C extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
> = (id: CollectionIdOf<C>) => IndexIdOf<I>;

/**
 * `toIndexId` is optional when the index's ids are strings — `String(_id)`
 * is then the default — and required otherwise.
 */
type IdOption<C extends AnyCollectionDefinition, I extends AnyIndexDefinition> =
	string extends IndexIdOf<I>
		? {
				/** The index id of a document. Default `String(_id)`. */
				toIndexId?: ToIndexId<C, I>;
			}
		: {
				/** The index id of a document: the index's ids are not strings. */
				toIndexId: ToIndexId<C, I>;
			};

export type SearchSyncOptions<
	C extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
> = {
	/** Where the documents are: a collection from `getCollection`. */
	collection: TypedCollection<C>;
	/** Where they go: an index from `bindIndex`. */
	index: TypedIndex<I>;
	/**
	 * A document as the index holds it. Its primary key must be the document's
	 * index id. `null` keeps a document out of the index. It runs for every
	 * change, so a document that stops qualifying is taken out.
	 */
	transform: Transform<C, I>;
	/**
	 * What this sync's state is recorded under, in `stateCollection`.
	 * Default `'<collection>:<index uid>'`. Two syncs with one name share a
	 * resume point, which is never what you want.
	 */
	name?: string;
	/** Where the resume point is kept, in the collection's database. Default `'nxgt_search_sync'`. */
	stateCollection?: string;
	/** How many changes are sent to Meilisearch at once. Default `500`. */
	batchSize?: number;
	/** How long a change waits for others before it is sent, in ms. Default `1000`. */
	flushIntervalMs?: number;
	/**
	 * How often, in ms, a sync with nothing to send records where the stream
	 * is anyway. Default `60000`. It is what keeps a quiet collection's
	 * resume point inside the server's history; one write per interval, and
	 * none while nothing moves at all.
	 */
	positionIntervalMs?: number;
	/**
	 * How many documents a reindex reads per page; above the collection's
	 * `maxPageSize`, lowered to it. Default `100`.
	 */
	pageSize?: number;
	/**
	 * What `start` does when the resume point is older than the server's
	 * history: `'reindex'` (default) reindexes and follows from there;
	 * `'fail'` throws a `SearchSyncError` with the code `HISTORY_LOST`.
	 */
	onHistoryLost?: 'reindex' | 'fail';
} & IdOption<C, I>;

/** What a sync has recorded. */
export interface SearchSyncState {
	/** The sync's name. */
	_id: string;
	/** Where following resumes. */
	resumeToken: ResumeToken;
	/** When the resume point last moved. */
	updatedAt: Date;
	/** When the last full reindex finished. */
	reindexedAt: Date | undefined;
}

export interface ReindexReport {
	/** Documents sent to the index. */
	indexed: number;
	/** Documents the transform kept out. */
	skipped: number;
	/** Documents that were in the index and are no longer wanted there. */
	removed: number;
}

/** A sync that is following the collection. */
export interface RunningSearchSync extends AsyncDisposable {
	/** Resolves once changes are being heard. */
	readonly ready: Promise<void>;
	/**
	 * Settles when it stops: resolves on `close()` or when the collection is
	 * dropped; rejects with a `SearchSyncError` when an error stopped it. What
	 * was not sent is sent again by the next `start`.
	 */
	readonly closed: Promise<CloseReason>;
	/** Sends what is waiting, and records how far it got. */
	flush(): Promise<void>;
	/** Sends what is waiting, then stops. */
	close(): Promise<void>;
}

export interface SearchSync {
	readonly name: string;
	/**
	 * Sends every live document through the transform to the index, removes
	 * what the index holds and should not, and records where following
	 * resumes: from before the reindex began, so no change is missed.
	 */
	reindex(): Promise<ReindexReport>;
	/**
	 * Follows the collection's changes into the index, from where the last
	 * run stopped. A sync with nothing recorded reindexes first.
	 */
	start(): Promise<RunningSearchSync>;
	/** What is recorded, or `undefined` before the first reindex. */
	state(): Promise<SearchSyncState | undefined>;
}

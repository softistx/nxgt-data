import type {
	EnqueuedTaskPromise,
	Filter,
	SearchParams,
	SearchResponse,
	Task,
	WaitOptions,
} from 'meilisearch';
import type {
	DocumentOf,
	FilterableOf,
	PrimaryKeyNameOf,
	SearchableOf,
	SortableOf,
} from '../definition/define-index';
import type { DocumentPath } from '../definition/paths';

export type OrderDirection = 'asc' | 'desc';

/**
 * A sort a definition allows: `attribute:asc|desc` on one of its
 * `sortableAttributes`, and `_geoPoint(lat, lng):asc|desc` when `_geo` is one.
 */
export type SortExpression<Def> =
	| `${SortableOf<Def>}:${OrderDirection}`
	| ('_geo' extends SortableOf<Def>
			? `_geoPoint(${string}):${OrderDirection}`
			: never);

/** An attribute of the document, or `*` for all of them. */
export type AttributeOrWildcard<Def> = DocumentPath<DocumentOf<Def>> | '*';

/**
 * The SDK's search parameters, with those that name attributes typed by the
 * definition. `filter` stays the SDK's string or array.
 */
export interface SearchOptions<Def>
	extends Omit<
		SearchParams,
		| 'q'
		| 'sort'
		| 'facets'
		| 'distinct'
		| 'attributesToRetrieve'
		| 'attributesToHighlight'
		| 'attributesToCrop'
		| 'attributesToSearchOn'
	> {
	/** Only the definition's `sortableAttributes`. */
	sort?: readonly SortExpression<Def>[];
	/** Only the definition's `filterableAttributes`, or `*`. */
	facets?: readonly (FilterableOf<Def> | '*')[];
	/** Only one of the definition's `filterableAttributes`. */
	distinct?: FilterableOf<Def>;
	attributesToRetrieve?: readonly AttributeOrWildcard<Def>[];
	attributesToHighlight?: readonly AttributeOrWildcard<Def>[];
	/** An attribute, `*`, or `attribute:length` for a length of its own. */
	attributesToCrop?: readonly (
		| AttributeOrWildcard<Def>
		| `${DocumentPath<DocumentOf<Def>>}:${number}`
	)[];
	/** Only the definition's `searchableAttributes`, when it names them. */
	attributesToSearchOn?: readonly SearchableOf<Def>[] | null;
}

/**
 * What `search` resolves to: the SDK's response, its hits typed as the
 * document, and its pagination fields as `page`/`hitsPerPage` choose.
 */
export type SearchResult<Def, Options = object> = SearchResponse<
	DocumentOf<Def>,
	SearchParams & Pick<Options, Extract<keyof Options, 'page' | 'hitsPerPage'>>
>;

/** A top-level attribute of the document, as `fields` takes one. */
export type FieldOf<Def> = keyof DocumentOf<Def> & string;

/** The document, or only the `fields` asked for. */
export type Selected<Doc, Fields extends string> = [Fields] extends [never]
	? Doc
	: Pick<Doc, Fields & keyof Doc>;

export interface FieldsOptions<Fields extends string> {
	/** Only these attributes of each document. */
	fields?: readonly Fields[];
}

/** The query of `list`: the SDK's, with `sort` and `fields` typed. */
export interface ListQuery<Def, Fields extends string = never>
	extends FieldsOptions<Fields> {
	filter?: Filter;
	sort?: readonly SortExpression<Def>[];
	limit?: number;
	offset?: number;
}

/** A page of documents, as `list` returns one. */
export interface DocumentPage<T> {
	results: T[];
	total: number;
	offset: number;
	limit: number;
}

/** A partial document for `update`: any attributes, and the id, required. */
export type DocumentPatch<Def> = Partial<DocumentOf<Def>> &
	Pick<DocumentOf<Def>, PrimaryKeyNameOf<Def>>;

export interface WriteOptions {
	/**
	 * Wait for the task, and resolve to it once it succeeded: `true`, or the
	 * SDK's `{ timeout, interval }`. A task that fails throws a
	 * `SearchIndexError`. Without it, a write resolves as soon as Meilisearch
	 * enqueued the task.
	 */
	wait?: boolean | WaitOptions;
	/** Stored on the task, as the SDK's `customMetadata`. */
	customMetadata?: string;
}

export interface BatchWriteOptions extends WriteOptions {
	/** Documents per task. The SDK's default is 1000. */
	batchSize?: number;
}

type Waits<W> = W extends true | WaitOptions ? true : false;

/**
 * What a write returns: the SDK's `EnqueuedTaskPromise`, or, with `wait`, the
 * finished `Task`.
 */
export type WriteResult<Options> = Options extends { wait?: infer W }
	? Waits<W> extends true
		? Waits<W> extends false
			? EnqueuedTaskPromise | Promise<Task>
			: Promise<Task>
		: EnqueuedTaskPromise
	: EnqueuedTaskPromise;

/** The same, for a write sent in batches: one task per batch. */
export type BatchWriteResult<Options> = Options extends { wait?: infer W }
	? Waits<W> extends true
		? Waits<W> extends false
			? EnqueuedTaskPromise[] | Promise<Task[]>
			: Promise<Task[]>
		: EnqueuedTaskPromise[]
	: EnqueuedTaskPromise[];

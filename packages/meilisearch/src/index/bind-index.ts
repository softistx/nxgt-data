import type { Filter, Index, Meilisearch, RecordAny } from 'meilisearch';
import type {
	AnyIndexDefinition,
	DocumentOf,
	IdOf,
} from '../definition/define-index';
import { INDEX_UID_SHAPE, isIndexUid } from '../definition/uid';
import {
	type RebuildFill,
	type RebuildOptions,
	type RebuildReport,
	rebuildIndex,
} from '../sync/rebuild-index';
import {
	type SyncOptions,
	type SyncReport,
	syncIndex,
} from '../sync/sync-index';
import { createContext } from './context';
import * as reads from './operations/reads';
import * as writes from './operations/writes';
import type {
	BatchWriteOptions,
	BatchWriteResult,
	DocumentPage,
	DocumentPatch,
	FieldOf,
	FieldsOptions,
	ListQuery,
	SearchOptions,
	SearchResult,
	Selected,
	WriteOptions,
	WriteResult,
} from './types';

/**
 * An index of the server, typed by its definition: its documents, its ids,
 * and the attributes its searches may sort and facet on.
 */
export interface TypedIndex<Def extends AnyIndexDefinition> {
	readonly uid: string;
	readonly definition: Def;
	readonly client: Meilisearch;
	/** The SDK's own index, for anything this one does not wrap. */
	readonly raw: Index<DocumentOf<Def> & RecordAny>;

	/** Creates the index and applies its settings, when they differ. See `syncIndex`. */
	sync(options?: SyncOptions): Promise<SyncReport>;
	/**
	 * Rebuilds the index beside the live one and swaps it in, so that a search
	 * never sees it half filled:
	 *
	 * 1. deletes a `<uid>_next` left by a run that did not finish;
	 * 2. creates `<uid>_next` with the definition's primary key and settings;
	 * 3. hands `fill` the typed index bound to it, and waits for every task
	 *    it left there, enqueued or not;
	 * 4. swaps it with the live index, in one atomic task — or renames it,
	 *    when there is no live index yet — and deletes the previous one.
	 *
	 * When creating the next index or applying its settings fails, `fill`
	 * throws, a task it left fails, or the swap task comes back failed, the
	 * next index is deleted — or the error says it could not — the live one is
	 * left as it was, and a `SearchIndexError` (`REBUILD_FAILED`) is thrown
	 * with the cause. When the swap was sent and could not be waited for, its
	 * outcome is unknown: nothing is deleted, and the error says so.
	 */
	rebuild(
		fill: RebuildFill<Def>,
		options?: RebuildOptions,
	): Promise<RebuildReport>;

	/** Adds documents, or replaces those whose id is already there. */
	add<const O extends WriteOptions = Record<never, never>>(
		documents: readonly DocumentOf<Def>[],
		options?: O,
	): WriteResult<O>;
	/** `add`, one task per `batchSize` documents. */
	addInBatches<const O extends BatchWriteOptions = Record<never, never>>(
		documents: readonly DocumentOf<Def>[],
		options?: O,
	): BatchWriteResult<O>;
	/** Merges each partial document into the one with its id, or adds it. */
	update<const O extends WriteOptions = Record<never, never>>(
		documents: readonly DocumentPatch<Def>[],
		options?: O,
	): WriteResult<O>;
	/** `update`, one task per `batchSize` documents. */
	updateInBatches<const O extends BatchWriteOptions = Record<never, never>>(
		documents: readonly DocumentPatch<Def>[],
		options?: O,
	): BatchWriteResult<O>;
	/** Deletes a document by id, or several by their ids. */
	delete<const O extends WriteOptions = Record<never, never>>(
		ids: IdOf<Def> | readonly IdOf<Def>[],
		options?: O,
	): WriteResult<O>;
	/**
	 * Deletes every document the filter matches, in one task, without reading
	 * their ids first. The filter is Meilisearch's, on the definition's
	 * `filterableAttributes`; an empty one is refused by the server when the
	 * request is sent, and one on another attribute fails the task.
	 */
	deleteByFilter<const O extends WriteOptions = Record<never, never>>(
		filter: Filter,
		options?: O,
	): WriteResult<O>;
	/** Deletes every document, and keeps the index and its settings. */
	deleteAll<const O extends WriteOptions = Record<never, never>>(
		options?: O,
	): WriteResult<O>;

	/** The document with this id, or `undefined`. */
	get<const F extends FieldOf<Def> = never>(
		id: IdOf<Def>,
		options?: FieldsOptions<F>,
	): Promise<Selected<DocumentOf<Def>, F> | undefined>;
	/** The documents with these ids, in Meilisearch's order; missing ids are left out. */
	getMany<const F extends FieldOf<Def> = never>(
		ids: readonly IdOf<Def>[],
		options?: FieldsOptions<F>,
	): Promise<Selected<DocumentOf<Def>, F>[]>;
	/** A page of documents, filtered and sorted. */
	list<const F extends FieldOf<Def> = never>(
		query?: ListQuery<Def, F>,
	): Promise<DocumentPage<Selected<DocumentOf<Def>, F>>>;

	/** Searches the index; the hits are documents. */
	search<const O extends SearchOptions<Def> = Record<never, never>>(
		query?: string | null,
		options?: O,
	): Promise<SearchResult<Def, O>>;
}

/**
 * Binds a definition to a client: the typed index. Nothing is sent: call
 * `sync` to create the index and apply its settings.
 *
 * The uid is checked again here, since a definition need not come from
 * `defineIndex`: one Meilisearch would refuse throws a `TypeError`, whose
 * message names no uid.
 *
 * ```ts
 * const movieIndex = bindIndex(client, movies);
 * await movieIndex.sync();
 * ```
 */
export function bindIndex<Def extends AnyIndexDefinition>(
	client: Meilisearch,
	definition: Def,
): TypedIndex<Def> {
	if (!isIndexUid(definition.uid)) {
		throw new TypeError(
			`bindIndex: the definition's uid must be ${INDEX_UID_SHAPE}`,
		);
	}
	const ctx = createContext(client, definition);
	const index: TypedIndex<Def> = {
		uid: ctx.uid,
		definition,
		client,
		raw: ctx.raw as TypedIndex<Def>['raw'],

		sync: (options) => syncIndex(client, definition, options),
		rebuild: (fill, options) =>
			rebuildIndex(
				client,
				definition,
				(next) => bindIndex(client, next),
				fill,
				options,
			),

		add: (documents, options) => writes.add(ctx, documents, options) as any,
		addInBatches: (documents, options) =>
			writes.addInBatches(ctx, documents, options) as any,
		update: (documents, options) =>
			writes.update(ctx, documents, options) as any,
		updateInBatches: (documents, options) =>
			writes.updateInBatches(ctx, documents, options) as any,
		delete: (ids, options) => writes.remove(ctx, ids, options) as any,
		deleteByFilter: (filter, options) =>
			writes.deleteByFilter(ctx, filter, options) as any,
		deleteAll: (options) => writes.deleteAll(ctx, options) as any,

		get: (id, options) => reads.get(ctx, id, options) as any,
		getMany: (ids, options) => reads.getMany(ctx, ids, options) as any,
		list: (query) => reads.list(ctx, query) as any,

		search: (query, options) => reads.search(ctx, query, options) as any,
	};
	return index;
}

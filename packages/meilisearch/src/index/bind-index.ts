import {
	type DocumentOptions,
	type EnqueuedTaskPromise,
	type Index,
	type Meilisearch,
	MeilisearchApiError,
	type RecordAny,
	type SearchParams,
	type Task,
	type WaitOptions,
} from 'meilisearch';
import type {
	AnyIndexDefinition,
	DocumentOf,
	IdOf,
} from '../definition/define-index';
import { assertSucceeded } from '../errors/search-index-error';
import {
	type SyncOptions,
	type SyncReport,
	syncIndex,
} from '../sync/sync-index';
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

/** The SDK types documents as mutable records; they are only read. */
function records(documents: readonly unknown[]): RecordAny[] {
	return documents as RecordAny[];
}

function waitOptions(wait: boolean | WaitOptions | undefined) {
	return wait === true ? {} : wait || undefined;
}

/**
 * Binds a definition to a client: the typed index. Nothing is sent: call
 * `sync` to create the index and apply its settings.
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
	const { uid, primaryKey } = definition;
	const raw = client.index<RecordAny>(uid);

	// Every write names the primary key: an index a write creates, before any
	// `sync`, then gets the definition's instead of one Meilisearch guesses.
	const documentOptions = (options: WriteOptions = {}): DocumentOptions => ({
		primaryKey,
		...(options.customMetadata === undefined
			? {}
			: { customMetadata: options.customMetadata }),
	});
	const taskOptions = (options: WriteOptions = {}) =>
		options.customMetadata === undefined
			? undefined
			: { customMetadata: options.customMetadata };

	const settle = (enqueued: EnqueuedTaskPromise, options?: WriteOptions) => {
		const wait = waitOptions(options?.wait);
		if (wait === undefined) return enqueued;
		return enqueued
			.waitTask(wait)
			.then((task: Task) => assertSucceeded(task, uid));
	};
	const settleAll = (
		enqueued: EnqueuedTaskPromise[],
		options?: WriteOptions,
	) => {
		const wait = waitOptions(options?.wait);
		if (wait === undefined) return enqueued;
		return Promise.all(
			enqueued.map((task) =>
				task.waitTask(wait).then((done) => assertSucceeded(done, uid)),
			),
		);
	};

	const index: TypedIndex<Def> = {
		uid,
		definition,
		client,
		raw: raw as TypedIndex<Def>['raw'],

		sync: (options) => syncIndex(client, definition, options),

		add: (documents, options) =>
			settle(
				raw.addDocuments(records(documents), documentOptions(options)),
				options,
			) as any,
		addInBatches: (documents, options) =>
			settleAll(
				raw.addDocumentsInBatches(
					records(documents),
					options?.batchSize,
					documentOptions(options),
				),
				options,
			) as any,
		update: (documents, options) =>
			settle(
				raw.updateDocuments(records(documents), documentOptions(options)),
				options,
			) as any,
		updateInBatches: (documents, options) =>
			settleAll(
				raw.updateDocumentsInBatches(
					records(documents),
					options?.batchSize,
					documentOptions(options),
				),
				options,
			) as any,
		delete: (ids, options) =>
			settle(
				Array.isArray(ids)
					? raw.deleteDocuments(ids as string[], taskOptions(options))
					: raw.deleteDocument(ids as string | number, taskOptions(options)),
				options,
			) as any,
		deleteAll: (options) =>
			settle(raw.deleteAllDocuments(taskOptions(options)), options) as any,

		get: async (id, options) => {
			try {
				return (await raw.getDocument(
					id as string | number,
					options?.fields ? { fields: [...options.fields] } : undefined,
				)) as any;
			} catch (error) {
				if (
					error instanceof MeilisearchApiError &&
					error.cause?.code === 'document_not_found'
				) {
					return undefined;
				}
				throw error;
			}
		},
		getMany: async (ids, options) => {
			if (ids.length === 0) return [];
			const { results } = await raw.getDocuments<RecordAny>({
				ids: [...ids] as string[],
				limit: ids.length,
				...(options?.fields ? { fields: [...options.fields] } : {}),
			});
			return results as any;
		},
		list: async (query = {}) => {
			const { fields, sort, ...rest } = query;
			const page = await raw.getDocuments<RecordAny>({
				...rest,
				...(fields ? { fields: [...fields] } : {}),
				...(sort ? { sort: [...sort] } : {}),
			});
			return {
				results: page.results,
				total: page.total,
				offset: page.offset ?? query.offset ?? 0,
				limit: page.limit ?? query.limit ?? page.results.length,
			} as any;
		},

		search: (query, options) =>
			raw.search(query, options as SearchParams | undefined) as any,
	};
	return index;
}

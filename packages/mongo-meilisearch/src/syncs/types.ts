import type {
	AnyIndexDefinition,
	SyncOptions,
	SyncReport,
} from '@nxgt/meilisearch';
import type {
	AnyCollectionDefinition,
	CollectionsIn,
	CollectionsOf,
	DbName,
} from '@nxgt/mongo';
import type {
	ReindexReport,
	RunningSearchSync,
	SearchSync,
	SearchSyncOptions,
	SearchSyncState,
} from '../sync/types';

/**
 * What a Mongo's sole database holds, by the name each definition is exported
 * under — the same keys `mongo.db` answers to.
 *
 * A Mongo with several databases gives `never`, as `mongo.db` itself does:
 * this version follows the collections of one. See the README.
 */
export type SoleCollections<C> =
	DbName<C> extends infer N extends DbName<C>
		? [Exclude<DbName<C>, N>] extends [never]
			? CollectionsOf<CollectionsIn<C, N>>
			: never
		: never;

/**
 * One collection's entry: everything `createSearchSync` takes except the
 * collection itself, which the Mongo already holds.
 */
export type SearchSyncEntry<
	Col extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
> = Omit<SearchSyncOptions<Col, I>, 'collection'>;

/** The index definitions a config names, one per key. */
export type IndexMap<I> = { [K in keyof I]: AnyIndexDefinition };

/**
 * The config `createSearchSyncs` takes: an entry per collection, under the key
 * the Mongo wires that collection under.
 *
 * `I` is inferred from each entry's `index` alone, which is what lets a
 * `transform` be written inline — its document is typed by the collection the
 * key names, and its result by that index. A key the Mongo wires no collection
 * for is refused by name.
 */
export type SearchSyncsConfig<C, I extends IndexMap<I>> = {
	[K in keyof I]: K extends keyof SoleCollections<C>
		? SoleCollections<C>[K] extends infer Col extends AnyCollectionDefinition
			? SearchSyncEntry<Col, I[K]>
			: never
		: {
				index: `createSearchSyncs: this Mongo wires no collection called "${K & string}"`;
			};
};

/** A report per key of the config, under the same names. */
export type ByKey<S, T> = { readonly [K in keyof S]: T };

/**
 * Every collection's sync, wired to the Mongo's collections — not started.
 *
 * `syncs` is each one as `@nxgt/mongo-meilisearch` builds it, so anything
 * createSearchSyncs does not wrap is still reachable under its key.
 */
export interface SearchSyncs<S> {
	/** The syncs, under the keys the config used. */
	readonly syncs: ByKey<S, SearchSync>;
	/** Where each sync stands; `undefined` for one that never reindexed. */
	state(): Promise<ByKey<S, SearchSyncState | undefined>>;
	/**
	 * Brings every index the Mongo wires in line with its definition — created
	 * with its primary key, its settings updated where they differ — one
	 * after another, and reports each under its key. `@nxgt/meilisearch`'s
	 * `syncIndex`, per entry; the first that throws stops the rest. `dryRun`
	 * shows every settings difference, but a primary-key mismatch throws even
	 * then. A deployment step, run before `reindexAll` or `start`.
	 */
	syncIndexes(options?: SyncOptions): Promise<ByKey<S, SyncReport>>;
	/**
	 * Reindexes every collection, one after another, and reports each under
	 * its key. The first that throws stops the rest — a reindex removes what
	 * a collection no longer gives, so a half-finished run is not something
	 * to keep going from.
	 */
	reindexAll(): Promise<ByKey<S, ReindexReport>>;
	/**
	 * Starts every sync, and resolves once they are all hearing changes. One
	 * that fails closes the ones already started, so a failed `start` leaves
	 * nothing running.
	 */
	start(): Promise<RunningSearchSyncs<S>>;
}

/** Every sync of a started `createSearchSyncs`. */
export interface RunningSearchSyncs<S> extends AsyncDisposable {
	/** Each running sync, under the keys the config used. */
	readonly running: ByKey<S, RunningSearchSync>;
	/**
	 * Rejects with the first sync that stops on an error, and never resolves
	 * on its own — a sync that ends because `close` was called is not an
	 * event to wait for. **Await it or catch it**: an unhandled rejection
	 * ends the process.
	 */
	readonly failed: Promise<never>;
	/** Sends what every sync is holding, and records where each one is. */
	flush(): Promise<void>;
	/** Flushes, then stops every sync. Idempotent. */
	close(): Promise<void>;
}

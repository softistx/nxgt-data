import type { SyncOptions, SyncReport } from '@nxgt/meilisearch';
import type {
	ReindexReport,
	RunningSearchSync,
	SearchSync,
	SearchSyncState,
} from '@nxgt/mongo-meilisearch';

/** A report per key of the config, under the same names. */
export type ByKey<S, T> = { readonly [K in keyof S]: T };

/**
 * Every collection's sync, wired to the kit's collections — not started.
 *
 * `syncs` is each one as `@nxgt/mongo-meilisearch` builds it, so anything
 * this kit does not wrap is still reachable under its key.
 */
export interface SearchKit<S> {
	/** The syncs, under the keys the config used. */
	readonly syncs: ByKey<S, SearchSync>;
	/** Where each sync stands; `undefined` for one that never reindexed. */
	state(): Promise<ByKey<S, SearchSyncState | undefined>>;
	/**
	 * Brings every index the kit wires in line with its definition — created
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
	start(): Promise<RunningSearchKit<S>>;
}

/** Every sync of a started kit. */
export interface RunningSearchKit<S> extends AsyncDisposable {
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

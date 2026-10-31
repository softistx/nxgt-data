import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { ActorOf, TypedCollection } from '../collection/types';
import type { PingResult } from '../connection/connect';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import type {
	BucketDefinition,
	BucketIndexReport,
	TypedBucket,
} from '../gridfs';
import type { SyncOptions, SyncReport } from '../sync/sync-collection';
import type { WithTransactionOptions } from '../transaction/with-transaction';
import type {
	BucketsIn,
	BucketsOf,
	CollectionsIn,
	CollectionsOf,
	DbName,
	MongoConfig,
	WiredCollectionOptions,
} from './config/types';

/**
 * A database with its collections and buckets on it: `db.users` is the typed
 * collection, `db.avatars` the typed bucket, and everything the driver's `Db`
 * answers to is still there.
 */
export type DbScope<C, B = Record<never, never>> = {
	readonly [K in keyof CollectionsOf<C>]: TypedCollection<CollectionsOf<C>[K]>;
} & {
	readonly [K in keyof BucketsOf<B>]: BucketsOf<B>[K] extends infer D extends
		BucketDefinition
		? TypedBucket<D>
		: never;
} & Db;

/** The scope of the database named `N`. */
type ScopeOf<C, N extends DbName<C>> = DbScope<
	CollectionsIn<C, N>,
	BucketsIn<C, N>
>;

/** What `syncBuckets` reports: per database, per bucket key. */
export type BucketSyncReport<C> = {
	[N in DbName<C>]: {
		[K in keyof BucketsOf<BucketsIn<C, N>>]: BucketIndexReport[];
	};
};

/** Every definition the Mongo wires, whichever database it belongs to. */
type WiredDefinition<C> = {
	[N in DbName<C>]: CollectionsOf<CollectionsIn<C, N>>[keyof CollectionsOf<
		CollectionsIn<C, N>
	>];
}[DbName<C>];

type UnionToIntersection<U> = (
	U extends unknown
		? (u: U) => void
		: never
) extends (i: infer I) => void
	? I
	: never;

/**
 * Who a Mongo writes as: the actor every collection that stamps one agrees on.
 * A collection with no actor asks for nothing, and a Mongo whose collections
 * all stamp none has no `as` to call. Two collections whose actors are of
 * different types agree on nothing, so `as` cannot be called either — which
 * is the honest answer, since one call could not stamp both.
 */
export type MongoActor<C> = [ActorOf<WiredDefinition<C>>] extends [never]
	? never
	: UnionToIntersection<ActorOf<WiredDefinition<C>>>;

/**
 * The scope of a Mongo that has exactly one database, and `never` for a Mongo
 * that has several: with two, `mongo.databases.main` is the one that says which.
 */
export type SoleScope<C> =
	IsSole<DbName<C>> extends true ? ScopeOf<C, DbName<C>> : never;

/** Whether `N` is one name, not a union of several. */
type IsSole<N> = [N] extends [never]
	? false
	: [N] extends [UnionToIntersection<N>]
		? true
		: false;

/** A transaction's options, and which database's client carries it. */
export type MongoTransactionOptions<C> = WithTransactionOptions & {
	/** Required once the Mongo holds more than one client. */
	on?: DbName<C>;
};

/**
 * What `database` takes: which database's collections it derives from, and
 * the collection options merged over that database's — what the wiring
 * decides (`db`, `session`, `actor`, `autoSync`) is refused, as in the config.
 */
export interface DerivedDatabaseOptions<C, N extends DbName<C>> {
	from?: N | undefined;
	/** Over the source's `options`, for every collection. */
	options?: WiredCollectionOptions<AnyCollectionDefinition>;
	/** Over the source's `optionsFor`, per collection key. */
	optionsFor?: {
		[K in keyof CollectionsOf<CollectionsIn<C, N>>]?: WiredCollectionOptions<
			CollectionsOf<CollectionsIn<C, N>>[K]
		>;
	};
}

/** The config of a database `database(name)` derived: one database, same wiring. */
export type DerivedConfig<C, N extends DbName<C>> = {
	collections: CollectionsIn<C, N>;
	buckets: BucketsIn<C, N>;
};

/**
 * An application's MongoDB, wired: the collections on their database, the
 * clients, and what a request adds to them.
 */
export interface Mongo<C> extends AsyncDisposable {
	/**
	 * The only database's scope. `never` when the Mongo has several, where
	 * reading it anyway — from JavaScript, or across an `any` — throws.
	 */
	readonly db: SoleScope<C>;
	/**
	 * Every database's scope, under the name the config gave it, or `default`
	 * when it named none.
	 */
	readonly databases: {
		readonly [N in DbName<C>]: ScopeOf<C, N>;
	};
	/**
	 * The client of each database, under the same names; two databases on one
	 * URI share one, and must then be configured with the same `clientOptions`.
	 */
	readonly clients: { readonly [N in DbName<C>]: MongoClient };
	/** What this Mongo stamps into the `*By` fields, if any. */
	readonly actor: MongoActor<C> | undefined;
	/** The session every collection and bucket of this Mongo runs in, if any. */
	readonly session: ClientSession | undefined;

	/** The same mongo, stamping this actor: one call for every collection. */
	as(actor: MongoActor<C>): Mongo<C>;
	/** The same mongo, running in this session; `undefined` takes it away. */
	withSession(session: ClientSession | undefined): Mongo<C>;
	/**
	 * The same collections and buckets on another database of the same client,
	 * synchronously: a Mongo for a tenant's database, per request. It carries
	 * the actor (`as`) and the session or transaction this Mongo is in, builds
	 * its collections of its own, and keeps the source database's options and
	 * `autoSync` — which runs lazily on first use, so nothing here awaits.
	 * `sync()` on the result syncs that database explicitly.
	 *
	 * No connection is opened and the client stays open: like `as`, the result
	 * cannot be closed. It holds one database, read as `db` or
	 * `databases.default`. `from` names the database whose collections it
	 * takes, and is required once this Mongo holds several.
	 */
	database<N extends DbName<C> = DbName<C>>(
		name: string,
		...options: IsSole<DbName<C>> extends true
			? [options?: DerivedDatabaseOptions<C, N>]
			: [options: DerivedDatabaseOptions<C, N> & { from: N }]
	): Mongo<DerivedConfig<C, N>>;
	/**
	 * Runs `fn` in a transaction, with a Mongo whose collections and buckets
	 * are all in it: a file written there commits or rolls back with the
	 * documents beside it.
	 *
	 * The driver **retries `fn` from the start** on a transient error, so it
	 * must be safe to run twice. A transaction lives on one client: `on` says
	 * which database's, is required once the Mongo holds more than one, and only
	 * that client's databases can be used inside — the driver refuses a
	 * session another client owns. A call inside a transaction joins it, and
	 * takes no `on`.
	 */
	transaction<T>(
		fn: (mongo: Mongo<C>) => Promise<T>,
		options?: MongoTransactionOptions<C>,
	): Promise<T>;
	/**
	 * Syncs the wired collections, database by database, and reports each one
	 * under its name. The first database that throws stops the rest, so
	 * `dryRun` is the way to see everything at once.
	 */
	sync(options?: SyncOptions): Promise<Record<DbName<C>, SyncReport[]>>;
	/**
	 * Creates the indexes of every wired bucket, database by database, and
	 * reports each bucket under its key — `sync` leaves buckets alone. Until
	 * it has run, or a database's `autoSync` has, every read of a bucket
	 * scans its chunks. The first database that throws stops the rest; there
	 * is no `dryRun`, since a bucket's index creation has none.
	 */
	syncBuckets(): Promise<BucketSyncReport<C>>;
	/**
	 * Sends `ping` to every database at once, and reports each under its name:
	 * `{ ok: true, latencyMs }`, or `{ ok: false, error }`. Never throws, and
	 * answers within `timeoutMS` (default 2 s) either way — for a health
	 * endpoint. A database the Mongo opened reports the driver's own errors; one the
	 * config gave a `client` goes through a timer of its own, since an
	 * unconnected client's first connect ignores `timeoutMS`.
	 */
	ping(options?: {
		timeoutMS?: number;
	}): Promise<Record<DbName<C>, PingResult>>;
	/**
	 * Closes what this Mongo opened. Idempotent; a client the config gave is
	 * left alone, and only the Mongo `openMongo` returned may be closed.
	 */
	close(): Promise<void>;
}

/** What `openMongo` takes: a config `defineMongo` checked. */
export type MongoOf<Config> =
	Config extends MongoConfig<infer C> ? Mongo<C> : never;

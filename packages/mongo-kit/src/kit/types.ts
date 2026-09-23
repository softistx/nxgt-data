import type {
	ActorOf,
	PingResult,
	SyncOptions,
	SyncReport,
	TypedCollection,
} from '@nxgt/mongo';
import type {
	ClientSession,
	Db,
	MongoClient,
	TransactionOptions,
} from 'mongodb';
import type {
	CollectionsIn,
	CollectionsOf,
	DbName,
	KitConfig,
} from '../config/types';

/**
 * A database with its collections on it: `db.users` is the typed collection,
 * and everything the driver's `Db` answers to is still there.
 */
export type DbScope<C> = {
	readonly [K in keyof CollectionsOf<C>]: TypedCollection<CollectionsOf<C>[K]>;
} & Db;

/** Every definition the kit wires, whichever database it belongs to. */
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
 * Who a kit writes as: the actor every collection that stamps one agrees on.
 * A collection with no actor asks for nothing, and a kit whose collections
 * all stamp none has no `as` to call. Two collections whose actors are of
 * different types agree on nothing, so `as` cannot be called either — which
 * is the honest answer, since one call could not stamp both.
 */
export type KitActor<C> = [ActorOf<WiredDefinition<C>>] extends [never]
	? never
	: UnionToIntersection<ActorOf<WiredDefinition<C>>>;

/**
 * The scope of a kit that has exactly one database, and `never` for a kit
 * that has several: with two, `kit.databases.main` is the one that says which.
 */
export type SoleScope<C> =
	DbName<C> extends infer N extends DbName<C>
		? [Exclude<DbName<C>, N>] extends [never]
			? DbScope<CollectionsIn<C, N>>
			: never
		: never;

/** A transaction's options, and which database's client carries it. */
export type KitTransactionOptions<C> = TransactionOptions & {
	/** Required once the kit holds more than one client. */
	on?: DbName<C>;
};

/**
 * An application's MongoDB, wired: the collections on their database, the
 * clients, and what a request adds to them.
 */
export interface MongoKit<C> extends AsyncDisposable {
	/**
	 * The only database's scope. `never` when the kit has several, where
	 * reading it anyway — from JavaScript, or across an `any` — throws.
	 */
	readonly db: SoleScope<C>;
	/**
	 * Every database's scope, under the name the config gave it, or `default`
	 * when it named none.
	 */
	readonly databases: {
		readonly [N in DbName<C>]: DbScope<CollectionsIn<C, N>>;
	};
	/**
	 * The client of each database, under the same names; two databases on one
	 * URI share one, and must then be configured with the same `clientOptions`.
	 */
	readonly clients: { readonly [N in DbName<C>]: MongoClient };
	/** What this kit stamps into the `*By` fields, if any. */
	readonly actor: KitActor<C> | undefined;
	/** The session every collection of this kit runs in, if any. */
	readonly session: ClientSession | undefined;

	/** The same kit, stamping this actor: one call for every collection. */
	as(actor: KitActor<C>): MongoKit<C>;
	/** The same kit, running in this session; `undefined` takes it away. */
	withSession(session: ClientSession | undefined): MongoKit<C>;
	/**
	 * Runs `fn` in a transaction, with a kit whose collections are all in it.
	 *
	 * The driver **retries `fn` from the start** on a transient error, so it
	 * must be safe to run twice. A transaction lives on one client: `on` says
	 * which database's, is required once the kit holds more than one, and only
	 * that client's databases can be used inside — the driver refuses a
	 * session another client owns. A call inside a transaction joins it, and
	 * takes no `on`.
	 */
	transaction<T>(
		fn: (kit: MongoKit<C>) => Promise<T>,
		options?: KitTransactionOptions<C>,
	): Promise<T>;
	/**
	 * Syncs the wired collections, database by database, and reports each one
	 * under its name. The first database that throws stops the rest, so
	 * `dryRun` is the way to see everything at once.
	 */
	sync(options?: SyncOptions): Promise<Record<DbName<C>, SyncReport[]>>;
	/**
	 * Sends `ping` to every database at once, and reports each under its name:
	 * `{ ok: true, latencyMs }`, or `{ ok: false, error }`. Never throws, and
	 * answers within `timeoutMS` (default 2 s) either way — for a health
	 * endpoint. A database the config gave a `client` is pinged the same way.
	 */
	ping(options?: {
		timeoutMS?: number;
	}): Promise<Record<DbName<C>, PingResult>>;
	/**
	 * Closes what this kit opened. Idempotent; a client the config gave is
	 * left alone, and only the kit `createKit` returned may be closed.
	 */
	close(): Promise<void>;
}

/** What `createKit` takes: a config `defineConfig` checked. */
export type KitOf<Config> =
	Config extends KitConfig<infer C> ? MongoKit<C> : never;

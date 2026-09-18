import type { AnyCollectionDefinition, CollectionOptions } from '@nxgt/mongo';
import type { Db, MongoClient, MongoClientOptions } from 'mongodb';

/**
 * The collections of a module, as `import * as collections` gives them: its
 * other exports — types are gone already, and a function or a constant is no
 * definition — are left out of the scope rather than refused.
 */
export type CollectionsOf<C> = {
	[K in keyof C as C[K] extends AnyCollectionDefinition ? K : never]: C[K];
};

/**
 * A name the driver's `Db` already uses. The scope carries the collections
 * over a `Db`, so a collection under one of these names would be unreachable
 * — and `db.watch` would answer something other than what a caller expects.
 *
 * Read from the driver's own type, never from a list of ours: a member the
 * driver adds is covered the day the pin moves. At run time the same question
 * is asked of the object itself, with `in`.
 */
export type ReservedName = keyof Db;

/** The keys of `C` that a `Db` already answers to. */
export type Collides<C> = Extract<keyof CollectionsOf<C>, ReservedName>;

/**
 * Makes a colliding key unassignable, and says why where the developer is
 * looking: under that key, the value would have to be a string no definition
 * is.
 */
export type NoCollision<C> = [Collides<C>] extends [never]
	? unknown
	: {
			[K in Collides<C>]: `"${K & string}" is a member of the driver's Db: wire this collection under another key`;
		};

/**
 * Makes options written for a key no collection is wired under unassignable,
 * and says so under that key — the same shape as `NoCollision`.
 */
export type Unwired<Cols, OF> = [
	Exclude<keyof OF, keyof CollectionsOf<Cols>>,
] extends [never]
	? unknown
	: {
			[K in Exclude<
				keyof OF,
				keyof CollectionsOf<Cols>
			>]: `"${K & string}" is not wired by this database: there are no options for it`;
		};

/** The options of one collection, minus what the kit decides itself. */
export type KitCollectionOptions<Def> = Omit<
	CollectionOptions<Def>,
	'db' | 'session' | 'actor' | 'autoSync'
>;

/** One database: where it is, and what it holds. */
export interface DatabaseConfig<C> {
	/**
	 * Where to connect. One of `uri` and `client`, never both. Databases on
	 * one URI share a client, which the kit closes with its last holder.
	 */
	uri?: string;
	/**
	 * A client the application opened. The kit uses it and **never closes
	 * it**: what it did not open is not its to close.
	 */
	client?: MongoClient;
	/** Passed to the driver with `uri`. Refused with `client`, which has its own. */
	clientOptions?: MongoClientOptions;
	/** The database's name. Default: the one the URI names, or `test`. */
	database?: string;
	/** `import * as collections from './models'`, passed as it is. */
	collections: C;
	/** For every collection of this database. */
	options?: KitCollectionOptions<AnyCollectionDefinition>;
	/** For one collection, merged over `options`. */
	optionsFor?: {
		[K in keyof CollectionsOf<C>]?: KitCollectionOptions<CollectionsOf<C>[K]>;
	};
	/**
	 * Sync each collection before its first operation, once per database:
	 * `@nxgt/mongo`'s `autoSync`. For tests and development, never for
	 * production, where `sync()` is a deployment step.
	 */
	autoSync?: boolean;
}

/** One database, or several under their names. */
export type KitConfigInput =
	| DatabaseConfig<object>
	| { databases: Record<string, DatabaseConfig<object>> };

/**
 * The config with every key it has to refuse — one the driver's `Db` already
 * answers to, or options for a collection that is not wired — turned into the
 * message above. `defineConfig` takes its argument as `C & Checked<C>`, and a
 * constraint written that way is what makes the refusal land on the key the
 * application wrote, rather than on the whole object.
 */
export type Checked<C> = C extends { databases: infer D }
	? {
			databases: {
				[N in keyof D]: CheckedDatabase<D[N]>;
			};
		}
	: CheckedDatabase<C>;

/** One database's collections, and the options written for them. */
type CheckedDatabase<D> = D extends { collections: infer Cols }
	? { collections: Cols & NoCollision<Cols> } & (D extends {
			optionsFor: infer OF;
		}
			? { optionsFor: OF & Unwired<Cols, OF> }
			: unknown)
	: D;

/** The databases of a config, whichever of the two shapes it was written in. */
export type DatabasesOf<C> = C extends { databases: infer D }
	? D
	: { default: C };

/** The name of every database. */
export type DbName<C> = keyof DatabasesOf<C> & string;

/** The collections of one database, as they were passed. */
export type CollectionsIn<C, N extends DbName<C>> = DatabasesOf<C>[N] extends {
	collections: infer Cols;
}
	? Cols
	: never;

/**
 * What `defineConfig` gives back: the databases under their names, checked
 * and frozen, carrying the shape it was written in — which is what decides
 * whether the kit has a `db` of its own.
 */
export interface KitConfig<C> {
	readonly databases: {
		readonly [N in DbName<C>]: DatabaseConfig<CollectionsIn<C, N>>;
	};
}

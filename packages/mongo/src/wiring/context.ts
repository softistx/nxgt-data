import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { MongoConnection } from '../connection/connect';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import { WiringError } from '../errors/wiring-error';
import type { BucketDefinition } from '../gridfs';
import { checkDatabaseName } from './config/database-name';
import type {
	WiredBucketOptions,
	WiredCollectionOptions,
} from './config/types';

/** A collection as the Mongo holds it: the key it is reached by, and its definition. */
export type Wired = readonly [key: string, definition: AnyCollectionDefinition];

/** A bucket as the Mongo holds it, the same way. */
export type WiredBucket = readonly [key: string, definition: BucketDefinition];

/** One database of a mongo, resolved once: data, like `@nxgt/mongo`'s own context. */
export interface DatabaseContext {
	/** The name the config gave it, which is the key on `mongo.databases`. */
	readonly name: string;
	readonly db: Db;
	readonly client: MongoClient;
	readonly wired: readonly Wired[];
	readonly options: WiredCollectionOptions<never>;
	readonly optionsFor: Readonly<Record<string, WiredCollectionOptions<never>>>;
	readonly autoSync: boolean;
	/** The buckets, beside the collections; none when the config gave none. */
	readonly buckets: readonly WiredBucket[];
	/** For every bucket, without the session or `autoSync`, which are the Mongo's. */
	readonly bucketOptions: WiredBucketOptions;
	/**
	 * The connection the Mongo opened, or `undefined` when the config gave a
	 * client: what it did not open is not its to close.
	 */
	readonly connection: MongoConnection | undefined;
}

/** What one Mongo works from. A derived Mongo shares the databases, not the cache. */
export interface WiringContext {
	readonly databases: readonly DatabaseContext[];
	readonly session: ClientSession | undefined;
	readonly actor: unknown;
	/** The collections already built, per database name then per key. */
	readonly cache: Map<string, Map<string, unknown>>;
	/**
	 * The config's default `retryTransient`, carried by every derived Mongo;
	 * `undefined` when the config gave none.
	 */
	readonly retryTransient: boolean | undefined;
	/** Whether this is the Mongo `openMongo` returned, the only one to close. */
	readonly root: boolean;
}

/** The same Mongo over another session or actor: a fresh cache, the same databases. */
export function derived(
	ctx: WiringContext,
	change: { session?: ClientSession | undefined; actor?: unknown },
): WiringContext {
	return {
		databases: ctx.databases,
		session: 'session' in change ? change.session : ctx.session,
		actor: 'actor' in change ? change.actor : ctx.actor,
		retryTransient: ctx.retryTransient,
		cache: new Map(),
		root: false,
	};
}

/** The database under this name, or the one there is. */
export function databaseOf(ctx: WiringContext, name: string): DatabaseContext {
	const found = ctx.databases.find((database) => database.name === name);
	if (!found) {
		throw new WiringError(
			'NO_DATABASE',
			`No database "${name}" in this Mongo: it has ${ctx.databases
				.map((database) => `"${database.name}"`)
				.join(', ')}.`,
			{ database: name },
		);
	}
	return found;
}

/** What `database` takes besides the name; the types say more than this. */
export interface DerivedDatabase {
	from?: string | undefined;
	options?: object | undefined;
	optionsFor?: Record<string, object> | undefined;
}

/** The four options the wiring decides, refused in a `database` override. */
const OWNED = ['db', 'session', 'actor', 'autoSync'] as const;

function checkObject(what: string, value: unknown, key?: string): void {
	if (value === undefined) return;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new WiringError('CONFIG', `database: ${what} must be an object.`, {
			key,
		});
	}
}

function checkOverride(what: string, options: unknown, key?: string): void {
	if (typeof options !== 'object' || options === null) return;
	for (const owned of OWNED) {
		if (owned in options) {
			throw new WiringError(
				'CONFIG',
				`database: ${what} has "${owned}", which the wiring decides.`,
				{ key },
			);
		}
	}
}

/**
 * The same Mongo over another database of the same client, found by name
 * and with no connection of its own: the client is the source database's,
 * its collections, buckets, options and `autoSync` are carried, and the
 * session and the actor travel with the context. `options` and `optionsFor`
 * are merged over the source's, derived over source (see `optionsFor` below). It holds one database, under the key
 * `default`, whatever the source's key was.
 */
export function derivedDatabase(
	ctx: WiringContext,
	name: string,
	change: DerivedDatabase = {},
): WiringContext {
	checkDatabaseName(name);
	if (typeof change !== 'object' || change === null) {
		throw new WiringError(
			'CONFIG',
			'database: the second argument must be an object, as `{ from: "main" }`.',
		);
	}
	const { from } = change;
	let source: DatabaseContext | undefined;
	if (from === undefined) {
		if (ctx.databases.length !== 1) {
			throw new WiringError(
				'SEVERAL_DATABASES',
				'database: this Mongo has several databases. Say which one the ' +
					'collections come from, as `{ from: "main" }`.',
			);
		}
		source = ctx.databases[0];
	} else {
		source = databaseOf(ctx, from);
	}
	if (!source) {
		throw new WiringError(
			'NO_DATABASE',
			'database: this Mongo has no database.',
		);
	}
	checkObject('options', change.options);
	checkObject('optionsFor', change.optionsFor);
	checkOverride('options', change.options);
	const keys = new Set(source.wired.map(([key]) => key));
	for (const [key, options] of Object.entries(change.optionsFor ?? {})) {
		if (!keys.has(key)) {
			throw new WiringError(
				'CONFIG',
				`database: optionsFor has options for "${key}", which it does not wire.`,
				{ key },
			);
		}
		checkObject(`the options of "${key}"`, options, key);
		checkOverride(`the options of "${key}"`, options, key);
	}
	const optionsFor: Record<
		string,
		WiringContext['databases'][number]['options']
	> = { ...source.optionsFor };
	// The scope reads `options` then `optionsFor[key]`: for a key the source
	// gave options of its own, fold the derived `options` in below the derived
	// `optionsFor`, so the order is source options < source optionsFor <
	// derived options < derived optionsFor.
	for (const key of Object.keys(optionsFor)) {
		optionsFor[key] = { ...optionsFor[key], ...change.options } as never;
	}
	for (const [key, options] of Object.entries(change.optionsFor ?? {})) {
		optionsFor[key] = { ...optionsFor[key], ...options } as never;
	}
	const database: DatabaseContext = {
		...source,
		name: 'default',
		db: source.client.db(name),
		options: { ...source.options, ...change.options } as never,
		optionsFor,
		// The client stays the one the Mongo opened, or the config gave.
		connection: undefined,
	};
	return {
		databases: [database],
		session: ctx.session,
		actor: ctx.actor,
		retryTransient: ctx.retryTransient,
		cache: new Map(),
		root: false,
	};
}

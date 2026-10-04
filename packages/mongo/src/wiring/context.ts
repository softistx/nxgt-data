import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { MongoConnection } from '../connection/connect';
import type { AnyCollectionDefinition } from '../definition/define-collection';
import { WiringError } from '../errors/wiring-error';
import type { BucketDefinition } from '../gridfs';
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

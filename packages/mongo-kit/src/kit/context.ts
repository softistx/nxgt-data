import type { AnyCollectionDefinition, MongoConnection } from '@nxgt/mongo';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { KitCollectionOptions } from '../config/types';

/** A collection as the kit holds it: the key it is reached by, and its definition. */
export type Wired = readonly [key: string, definition: AnyCollectionDefinition];

/** One database of a kit, resolved once: data, like `@nxgt/mongo`'s own context. */
export interface DatabaseContext {
	/** The name the config gave it, which is the key on `kit.databases`. */
	readonly name: string;
	readonly db: Db;
	readonly client: MongoClient;
	readonly wired: readonly Wired[];
	readonly options: KitCollectionOptions<never>;
	readonly optionsFor: Readonly<Record<string, KitCollectionOptions<never>>>;
	readonly autoSync: boolean;
	/**
	 * The connection the kit opened, or `undefined` when the config gave a
	 * client: what it did not open is not its to close.
	 */
	readonly connection: MongoConnection | undefined;
}

/** What one kit works from. A derived kit shares the databases, not the cache. */
export interface KitContext {
	readonly databases: readonly DatabaseContext[];
	readonly session: ClientSession | undefined;
	readonly actor: unknown;
	/** The collections already built, per database name then per key. */
	readonly cache: Map<string, Map<string, unknown>>;
	/** Whether this is the kit `createKit` returned, the only one to close. */
	readonly root: boolean;
}

/** The same kit over another session or actor: a fresh cache, the same databases. */
export function derived(
	ctx: KitContext,
	change: { session?: ClientSession | undefined; actor?: unknown },
): KitContext {
	return {
		databases: ctx.databases,
		session: 'session' in change ? change.session : ctx.session,
		actor: 'actor' in change ? change.actor : ctx.actor,
		cache: new Map(),
		root: false,
	};
}

/** The database under this name, or the one there is. */
export function databaseOf(ctx: KitContext, name: string): DatabaseContext {
	const found = ctx.databases.find((database) => database.name === name);
	if (!found) {
		throw new TypeError(
			`This kit has no database "${name}": it has ${ctx.databases
				.map((database) => `"${database.name}"`)
				.join(', ')}.`,
		);
	}
	return found;
}

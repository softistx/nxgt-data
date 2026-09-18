import { getCollection } from '@nxgt/mongo';
import type { DatabaseContext, KitContext } from './context';

/**
 * The collection under `key`, built the first time it is read and kept:
 * `getCollection` caches nothing, so a scope that built them all would pay
 * for every collection on every request that derives a kit.
 */
export function collectionAt(
	ctx: KitContext,
	database: DatabaseContext,
	key: string,
	definition: DatabaseContext['wired'][number][1],
): unknown {
	let built = ctx.cache.get(database.name);
	if (!built) {
		built = new Map();
		ctx.cache.set(database.name, built);
	}
	const found = built.get(key);
	if (found) return found;
	const collection = getCollection(database.db, definition, {
		...database.options,
		...database.optionsFor[key],
		...(database.autoSync ? { autoSync: true } : {}),
		...(ctx.session ? { session: ctx.session } : {}),
		...(ctx.actor === undefined ? {} : { actor: ctx.actor }),
	} as never);
	built.set(key, collection);
	return collection;
}

/**
 * A database with its collections on it. The collections are own properties,
 * so `Object.keys` lists them; everything else is the driver's `Db`, read
 * through a proxy — the shape `getCollection` already uses to put this
 * package's methods over the driver's collection.
 *
 * A key the `Db` already answers to never reaches here: `createKit` refuses
 * it, and the types refuse it before that.
 */
export function scopeOf(ctx: KitContext, database: DatabaseContext): object {
	const collections: Record<string, unknown> = {};
	for (const [key, definition] of database.wired) {
		Object.defineProperty(collections, key, {
			enumerable: true,
			get: () => collectionAt(ctx, database, key, definition),
		});
	}
	return new Proxy(collections, {
		get(target, key, receiver) {
			if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
			const value = Reflect.get(database.db, key) as unknown;
			return typeof value === 'function' ? value.bind(database.db) : value;
		},
		has(target, key) {
			return Reflect.has(target, key) || Reflect.has(database.db, key);
		},
	});
}

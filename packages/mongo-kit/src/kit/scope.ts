import { getCollection } from '@nxgt/mongo';
import { type BucketDefinition, getFiles } from '@nxgt/mongo/gridfs';
import type { DatabaseContext, KitContext } from './context';

/**
 * What sits under `key` in this kit's cache, built by `build` the first time
 * it is read. One cache for collections and buckets alike: a key is one or
 * the other, never both, which `defineConfig` refuses.
 */
function cached(
	ctx: KitContext,
	database: DatabaseContext,
	key: string,
	build: () => unknown,
): unknown {
	let built = ctx.cache.get(database.name);
	if (!built) {
		built = new Map();
		ctx.cache.set(database.name, built);
	}
	const found = built.get(key);
	if (found) return found;
	const value = build();
	built.set(key, value);
	return value;
}

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
	return cached(ctx, database, key, () =>
		getCollection(database.db, definition, {
			...database.options,
			...database.optionsFor[key],
			...(database.autoSync ? { autoSync: true } : {}),
			...(ctx.session ? { session: ctx.session } : {}),
			...(ctx.actor === undefined ? {} : { actor: ctx.actor }),
		} as never),
	);
}

/**
 * The bucket under `key`, built and kept the way `collectionAt` keeps a
 * collection. It runs in the kit's session, so a file written in a
 * transaction is part of it, and takes the database's `autoSync`. A bucket
 * has no actor to carry.
 */
export function bucketAt(
	ctx: KitContext,
	database: DatabaseContext,
	key: string,
	definition: BucketDefinition,
): unknown {
	return cached(ctx, database, key, () =>
		getFiles(database.db, definition, {
			...database.bucketOptions,
			...(database.autoSync ? { autoSync: true } : {}),
			...(ctx.session ? { session: ctx.session } : {}),
		}),
	);
}

/**
 * A database with its collections and its buckets on it. They are own
 * properties, so `Object.keys` lists them; everything else is the driver's
 * `Db`, read through a proxy — the shape `getCollection` already uses to put
 * this package's methods over the driver's collection.
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
	for (const [key, definition] of database.buckets) {
		Object.defineProperty(collections, key, {
			enumerable: true,
			get: () => bucketAt(ctx, database, key, definition),
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

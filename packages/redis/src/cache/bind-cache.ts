import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { RedisError } from '../errors/redis-error';
import type { CacheDefinition } from './types';

/** A cache bound to a client: the definition, with somewhere to put it. */
export interface BoundCache<P, T> {
	/** The key this would use, for a caller that needs the string itself. */
	keyFor(params: P): string;
	/** The value, or `undefined` — a miss, an expiry, or a stale shape. */
	get(params: P): Promise<T | undefined>;
	/** Stores it for the definition's `ttl`, or the one given here. */
	set(params: P, value: T, options?: { ttl?: number }): Promise<void>;
	/**
	 * The value if it is there, otherwise what `load` gives — stored, and
	 * given back **as it was stored**, so a miss and a hit agree.
	 */
	remember(
		params: P,
		load: () => Promise<T> | T,
		options?: { ttl?: number },
	): Promise<T>;
	/** Forgets it. `true` when something was there. */
	delete(params: P): Promise<boolean>;
}

/**
 * Binds a cache definition to a client.
 *
 * ```ts
 * const users = bindCache(redis.client, userCache);
 * const user = await users.remember(id, () => loadUser(id));
 * ```
 *
 * A stored value is checked against the schema **both ways**. On the way out
 * a value that no longer matches is treated as a miss and forgotten, so an
 * older deploy's shape cannot reach the caller or crash it.
 */
export function bindCache<P, S extends z.ZodType>(
	client: RedisClient,
	definition: CacheDefinition<P, S>,
): BoundCache<P, z.output<S>> {
	type T = z.output<S>;
	const keyFor = (params: P) => `${definition.name}:${definition.key(params)}`;

	const checked = (key: string, value: unknown): T => {
		const result = definition.schema.safeParse(value);
		if (!result.success) {
			throw new RedisError(
				'INVALID',
				key,
				`This value does not match the schema "${definition.name}" stores: ` +
					result.error.issues.map((issue) => issue.message).join('; '),
				{ cause: result.error },
			);
		}
		return result.data as T;
	};

	/** Stores it, and gives back exactly what a later `get` will give back. */
	const set = async (params: P, value: T, options?: { ttl?: number }) => {
		const key = keyFor(params);
		const ttl = options?.ttl ?? definition.ttl;
		const stored = checked(key, value);
		await client.set(key, JSON.stringify(stored), 'EX', ttl);
		return stored;
	};

	const get = async (params: P): Promise<T | undefined> => {
		const key = keyFor(params);
		const stored = await client.get(key);
		if (stored === null) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(stored);
		} catch {
			// Not this package's JSON: somebody else's key, or a truncated
			// write. Either way it is not a value, so it is a miss.
			await client.del(key).catch(() => undefined);
			return undefined;
		}
		const result = definition.schema.safeParse(parsed);
		if (!result.success) {
			// A shape from an older deploy. A cache is not a source of truth,
			// so it is forgotten rather than thrown: the caller reloads. A
			// `del` that fails must not turn a documented miss into a throw.
			await client.del(key).catch(() => undefined);
			return undefined;
		}
		return result.data as T;
	};

	return {
		keyFor,
		get,
		set: async (params, value, options) => {
			await set(params, value, options);
		},
		delete: async (params) => (await client.del(keyFor(params))) > 0,
		async remember(params, load, options) {
			const found = await get(params);
			if (found !== undefined) return found;
			// What `set` stored, not what `load` handed over: a schema with a
			// default, a transform, or unknown keys to strip makes those two
			// different, and the caller that misses would then see something
			// nobody after it sees.
			return await set(params, await load(), options);
		},
	};
}

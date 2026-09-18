import type { z } from 'zod';
import type { CacheDefinition } from './types';

/**
 * Describes a cache. It talks to nothing: `bindCache` is what needs a client.
 *
 * ```ts
 * export const userCache = defineCache({
 * 	name: 'user',
 * 	key: (id: string) => id,
 * 	ttl: 300,
 * 	schema: z.object({ id: z.string(), email: z.string() }),
 * });
 * ```
 */
export function defineCache<P, S extends z.ZodType>(
	definition: CacheDefinition<P, S>,
): CacheDefinition<P, S> {
	if (definition.name.length === 0) {
		throw new TypeError('defineCache: a cache needs a name, for its keys');
	}
	if (!Number.isFinite(definition.ttl) || definition.ttl <= 0) {
		throw new TypeError(
			`defineCache: "${definition.name}" has a ttl of ${definition.ttl}; ` +
				'it is a number of seconds, and must be above zero',
		);
	}
	return Object.freeze({ ...definition });
}

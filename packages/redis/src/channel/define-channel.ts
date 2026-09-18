import type { z } from 'zod';

/** One pub/sub channel: its name, and the shape its messages carry. */
export interface ChannelDefinition<S extends z.ZodType> {
	readonly name: string;
	readonly schema: S;
	/**
	 * A channel has none: a message is not kept, so there is nothing to
	 * expire. It is declared as `never` because a `CacheDefinition` is
	 * otherwise structurally a channel — same `name`, same `schema` — and
	 * `publish(client, someCache, …)` would compile and publish on a channel
	 * named after the cache. This is what refuses it.
	 */
	readonly ttl?: never;
}

/**
 * Describes a channel. It talks to nothing.
 *
 * ```ts
 * export const userCreated = defineChannel({
 * 	name: 'user.created',
 * 	schema: z.object({ id: z.string(), email: z.string() }),
 * });
 * ```
 */
export function defineChannel<S extends z.ZodType>(
	definition: ChannelDefinition<S>,
): ChannelDefinition<S> {
	if (definition.name.length === 0) {
		throw new TypeError('defineChannel: a channel needs a name');
	}
	return Object.freeze({ ...definition });
}

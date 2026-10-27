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
	/**
	 * A channel has none: it holds no job for a worker to lease. It is
	 * declared as `never` because a `QueueDefinition` has no `ttl` and so is
	 * otherwise structurally a channel — `publish(client, someQueue, …)` would
	 * compile and publish on a channel named after the queue.
	 */
	readonly lease?: never;
	/**
	 * The key a message belongs to (a room, a user, a document), which
	 * `channel.stream(key)` filters on. Without it the channel has no keyed
	 * streams. A method, not a property, so that a channel defined for one
	 * schema stays assignable to the schema-less `AnyChannel`.
	 */
	key?(message: z.output<S>): string;
	/**
	 * `'local'`: when Redis cannot be reached, `publish` hands the (parsed)
	 * message to this process's open `stream()` iterators of its key and
	 * resolves with `0` instead of throwing. Other processes do not hear it,
	 * and it can arrive twice here if Redis applied the publish but the reply
	 * was lost. A message the schema refuses still throws. Off by default.
	 */
	fallback?: 'local';
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
 *
 * `key` names what a message is about, for `channel.stream(key)`:
 *
 * ```ts
 * export const roomChanged = defineChannel({
 * 	name: 'room.changed',
 * 	schema: z.object({ roomId: z.string() }),
 * 	key: (change) => change.roomId,
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

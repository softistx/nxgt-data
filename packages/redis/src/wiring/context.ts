import type { RedisClient } from 'bun';
import type { Subscription } from '../channel/pubsub';
import type { RedisConnection } from '../connection/connect';
import type { AnyCache, AnyChannel } from './types';

/** A definition and the key it is wired under. */
export type Wired<D> = readonly [key: string, definition: D];

/**
 * One Redis instance, resolved once.
 *
 * **Data only**, like `@nxgt/mongo`'s collection context and
 * `@nxgt/drizzle`'s repository context: every operation is a plain function
 * taking it as its first argument. A context that also returned the
 * functions closed over it would be the factory this package split up, one
 * size down.
 */
export interface InstanceContext {
	readonly name: string;
	readonly client: RedisClient;
	/** What goes in front of every key, or `undefined` when nothing does. */
	readonly prefix: string | undefined;
	readonly caches: readonly Wired<AnyCache>[];
	readonly channels: readonly Wired<AnyChannel>[];
	/**
	 * The connection the Redis opened, or `undefined` when the configuration
	 * gave a client: what it did not open is not its to close.
	 */
	readonly connection: RedisConnection | undefined;
}

/**
 * What one Redis works from.
 *
 * There is no derived redis here — Redis has no actor and no session — so
 * there is one context per redis and `close()` always belongs to it. That is
 * the one place this Redis is simpler than `@nxgt/mongo`'s wiring, which needs a
 * `root` flag to tell the closable redis from the derived ones.
 */
export interface WiringContext {
	readonly instances: readonly InstanceContext[];
	/** The bound caches already built, per instance name then per key. */
	readonly caches: Map<string, Map<string, unknown>>;
	/** The bound channels already built, per instance name then per key. */
	readonly channels: Map<string, Map<string, unknown>>;
	/**
	 * Every subscription this Redis started and nobody has closed.
	 *
	 * Mutable, and deliberately: a subscription holds a connection duplicated
	 * from the client, so one nobody closes is a leak that outlives the Redis.
	 * `close()` empties this before it closes the clients.
	 */
	readonly subscriptions: Set<Subscription>;
}

/** The instance of a Redis object under `name`, or the reason there is none. */
export function instanceAt(
	ctx: WiringContext,
	name: string | undefined,
	where: string,
): InstanceContext {
	if (name === undefined) {
		const [sole] = ctx.instances;
		if (ctx.instances.length !== 1 || !sole) {
			throw new TypeError(
				`${where}: this Redis holds ${ctx.instances.length} Redis instances, ` +
					'and this call lives on one. Name it, as ' +
					`{ on: '${ctx.instances[0]?.name ?? 'main'}' }.`,
			);
		}
		return sole;
	}
	const found = ctx.instances.find((instance) => instance.name === name);
	if (!found) {
		throw new TypeError(
			`${where}: this Redis has no instance named "${name}". It wires ` +
				`${ctx.instances.map((i) => `"${i.name}"`).join(', ')}.`,
		);
	}
	return found;
}

/**
 * A key with this instance's prefix in front of it.
 *
 * The same function for a cache name, a channel name and a lock key, so a
 * deployment's prefix covers everything the Redis writes and there is no third
 * place to remember.
 */
export function prefixed(instance: InstanceContext, name: string): string {
	return instance.prefix === undefined ? name : `${instance.prefix}:${name}`;
}

import type { RedisConnection, Subscription } from '@nxgt/redis';
import type { RedisClient } from 'bun';
import type { AnyCache, AnyChannel } from './types';

/** A definition and the key it is wired under. */
export type Wired<D> = readonly [key: string, definition: D];

/**
 * One Redis of a kit, resolved once.
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
	 * The connection the kit opened, or `undefined` when the configuration
	 * gave a client: what it did not open is not its to close.
	 */
	readonly connection: RedisConnection | undefined;
}

/**
 * What one kit works from.
 *
 * There is no derived kit here — Redis has no actor and no session — so
 * there is one context per kit and `close()` always belongs to it. That is
 * the one place this kit is simpler than `@nxgt/mongo-kit`, which needs a
 * `root` flag to tell the closable kit from the derived ones.
 */
export interface KitContext {
	readonly instances: readonly InstanceContext[];
	/** The bound caches already built, per instance name then per key. */
	readonly caches: Map<string, Map<string, unknown>>;
	/** The bound channels already built, per instance name then per key. */
	readonly channels: Map<string, Map<string, unknown>>;
	/**
	 * Every subscription this kit started and nobody has closed.
	 *
	 * Mutable, and deliberately: a subscription holds a connection duplicated
	 * from the client, so one nobody closes is a leak that outlives the kit.
	 * `close()` empties this before it closes the clients.
	 */
	readonly subscriptions: Set<Subscription>;
}

/** The instance of a kit under `name`, or the reason there is none. */
export function instanceAt(
	ctx: KitContext,
	name: string | undefined,
	where: string,
): InstanceContext {
	if (name === undefined) {
		const [sole] = ctx.instances;
		if (ctx.instances.length !== 1 || !sole) {
			throw new TypeError(
				`${where}: this kit holds ${ctx.instances.length} Redis instances, ` +
					'and this call lives on one. Name it, as ' +
					`{ on: '${ctx.instances[0]?.name ?? 'main'}' }.`,
			);
		}
		return sole;
	}
	const found = ctx.instances.find((instance) => instance.name === name);
	if (!found) {
		throw new TypeError(
			`${where}: this kit has no instance named "${name}". It wires ` +
				`${ctx.instances.map((i) => `"${i.name}"`).join(', ')}.`,
		);
	}
	return found;
}

/**
 * A key with this instance's prefix in front of it.
 *
 * The same function for a cache name, a channel name and a lock key, so a
 * deployment's prefix covers everything the kit writes and there is no third
 * place to remember.
 */
export function prefixed(instance: InstanceContext, name: string): string {
	return instance.prefix === undefined ? name : `${instance.prefix}:${name}`;
}

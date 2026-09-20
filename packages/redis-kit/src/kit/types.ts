import type {
	BoundCache,
	CacheDefinition,
	ChannelDefinition,
	LockOptions,
	ParamsOf,
	PingResult,
	SubscribeOptions,
	Subscription,
	ValueOf,
} from '@nxgt/redis';
import type { RedisClient } from 'bun';
import type { z } from 'zod';
import type {
	CachesIn,
	CachesOf,
	ChannelsIn,
	ChannelsOf,
	InstanceName,
	KitConfig,
} from '../config/types';

/** What a channel carries, read from the schema it was defined with. */
export type PayloadOf<D> =
	D extends ChannelDefinition<infer S> ? z.output<S> : never;

/**
 * One channel, bound to a client and carrying its prefixed name.
 *
 * `subscribe` is the kit's, not `@nxgt/redis`'s: it hands back the same
 * `Subscription` — so a caller can still close one early — and also records
 * it, so `kit.close()` closes the ones nobody did. Each subscription holds a
 * duplicated connection, which is what makes a forgotten one cost something.
 */
export interface BoundChannel<D> {
	/** The channel's name in Redis, prefix included. */
	readonly name: string;
	/** The number of subscribers Redis handed the message to. Not a delivery
	 * guarantee: pub/sub is fire-and-forget. */
	publish(payload: PayloadOf<D>): Promise<number>;
	subscribe(
		handler: (payload: PayloadOf<D>) => void | Promise<void>,
		options?: SubscribeOptions,
	): Promise<Subscription>;
}

export type CacheScope<Ca> = {
	readonly [K in keyof CachesOf<Ca>]: BoundCache<
		ParamsOf<CachesOf<Ca>[K]>,
		ValueOf<CachesOf<Ca>[K]>
	>;
};

export type ChannelScope<Ch> = {
	readonly [K in keyof ChannelsOf<Ch>]: BoundChannel<ChannelsOf<Ch>[K]>;
};

/** One Redis of a kit, with everything wired on it. */
export interface InstanceScope<Ca, Ch> {
	readonly cache: CacheScope<Ca>;
	readonly channels: ChannelScope<Ch>;
	/** The driver's client, for a command this package does not wrap. */
	readonly client: RedisClient;
	/** What goes in front of every key, or `undefined` when nothing does. */
	readonly prefix: string | undefined;
	/** `withLock`, on a key this instance's prefix is put in front of. */
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: LockOptions,
	): Promise<T>;
	/** Answers within `timeoutMs` either way, and never throws. */
	ping(options?: { timeoutMs?: number }): Promise<PingResult>;
}

/**
 * `true` when a union of instance names has exactly one member.
 *
 * The naive `[N] extends [never] ? … : …` is not enough: a check on a naked
 * union distributes, and two names then give a *union* of scopes rather than
 * nothing — which reads as `never` in an error message without being it. The
 * function-parameter trick turns the union into an intersection, and a union
 * of two names intersects to `never`, which `[N] extends [I]` catches.
 */
type Sole<N> = [N] extends [never]
	? false
	: (N extends unknown ? (x: N) => void : never) extends (x: infer I) => void
		? [N] extends [I]
			? true
			: false
		: false;

/**
 * The scope when the kit holds exactly one Redis, and `never` when it holds
 * several — where `kit.instances.<name>` is the way to say which.
 *
 * `never` rather than a union: naming one instance out of two by guessing is
 * how a write lands on the wrong Redis, and a type that will not compile
 * says so before anything runs. `test/types/kit.ts` assigns it to `never`
 * both ways, so the claim is checked rather than described.
 */
export type SoleInstance<C> =
	Sole<InstanceName<C>> extends true
		? InstanceScope<
				CachesIn<C, InstanceName<C>>,
				ChannelsIn<C, InstanceName<C>>
			>
		: never;

export type SoleCache<C> =
	Sole<InstanceName<C>> extends true
		? CacheScope<CachesIn<C, InstanceName<C>>>
		: never;

export type SoleChannels<C> =
	Sole<InstanceName<C>> extends true
		? ChannelScope<ChannelsIn<C, InstanceName<C>>>
		: never;

/** `lock` on a kit names the instance when there is more than one. */
export type KitLockOptions<C> = LockOptions & {
	/** Which Redis the lock lives on. Required when the kit holds several. */
	on?: InstanceName<C>;
};

/**
 * An application's Redis wiring: the clients, the caches and the channels,
 * in one object that closes everything it opened.
 *
 * There is no `as(actor)` and no `withSession`, as `@nxgt/mongo-kit` has:
 * Redis has neither an actor to stamp nor a session to carry, so a kit is
 * the same object for every request and is never derived.
 */
export interface RedisKit<C> extends AsyncDisposable {
	/** The caches, when the kit holds one Redis. `never` when it holds several. */
	readonly cache: SoleCache<C>;
	/** The channels, when the kit holds one Redis. `never` when it holds several. */
	readonly channels: SoleChannels<C>;
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceScope<
			CachesIn<C, N>,
			ChannelsIn<C, N>
		>;
	};
	readonly clients: { readonly [N in InstanceName<C>]: RedisClient };
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: KitLockOptions<C>,
	): Promise<T>;
	/** Every instance's `ping`, under its name. Never throws. */
	ping(options?: {
		timeoutMs?: number;
	}): Promise<Record<InstanceName<C>, PingResult>>;
	/**
	 * Closes every subscription this kit started, then every client it
	 * opened. A client the configuration handed in is left alone. Idempotent.
	 */
	close(): Promise<void>;
}

/** The kit a `defineConfig` result produces, for an application's own types. */
export type KitOf<Config> =
	Config extends KitConfig<infer C> ? RedisKit<C> : never;

/** A definition as this layer handles it: by key, loosely typed. */
export type AnyCache = CacheDefinition<never, z.ZodType>;
export type AnyChannel = ChannelDefinition<z.ZodType>;

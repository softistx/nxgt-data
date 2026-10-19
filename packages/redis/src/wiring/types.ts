import type { RedisClient } from 'bun';
import type { z } from 'zod';
import type { CacheDefinition } from '../cache/types';
import type { ChannelDefinition } from '../channel/define-channel';
import type { PingResult } from '../connection/connect';
import type { IdempotencyDefinition } from '../idempotency/types';
import type { LockOptions } from '../lock/with-lock';
import type { Duration } from '../queue/duration';
import type { QueueDefinition } from '../queue/types';
import type { RateLimitDefinition } from '../rate-limit/types';
import type {
	CachesIn,
	ChannelsIn,
	IdempotencyIn,
	InstanceName,
	LimitsIn,
	QueuesIn,
	RedisConfig,
} from './config/types';
import type {
	CacheScope,
	ChannelScope,
	IdempotencyScope,
	LimitScope,
	QueueScope,
} from './scope-types';

export type {
	BoundChannel,
	CacheScope,
	ChannelScope,
	IdempotencyScope,
	LimitScope,
	PayloadOf,
	QueueScope,
} from './scope-types';

/** Any queue definition: what `queues` of a configuration holds. */
export type AnyQueue = QueueDefinition<z.ZodType, z.ZodType | undefined>;

/** One Redis instance, with everything wired on it. */
export interface InstanceScope<
	Ca,
	Ch,
	Li = Record<never, never>,
	Id = Record<never, never>,
	Qu = Record<never, never>,
> {
	readonly cache: CacheScope<Ca>;
	readonly channels: ChannelScope<Ch>;
	/** Rate limits, bound under this instance's prefix: `<prefix>:<name>:<key>`. */
	readonly limits: LimitScope<Li>;
	/** Idempotent operations, bound under this instance's prefix likewise. */
	readonly idempotency: IdempotencyScope<Id>;
	/**
	 * Queues, bound under this instance's prefix: `queue:{<prefix>:<name>}:…`.
	 * Built on first read; nothing connects before the first call.
	 */
	readonly queues: QueueScope<Qu>;
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
 * The scope when the Redis object holds exactly one instance, and `never` when it holds
 * several — where `redis.instances.<name>` is the way to say which.
 *
 * `never` rather than a union: naming one instance out of two by guessing is
 * how a write lands on the wrong Redis, and a type that will not compile
 * says so before anything runs. `test/types/wiring.ts` assigns it to `never`
 * both ways, so the claim is checked rather than described.
 */
export type SoleInstance<C> =
	Sole<InstanceName<C>> extends true
		? InstanceScope<
				CachesIn<C, InstanceName<C>>,
				ChannelsIn<C, InstanceName<C>>,
				LimitsIn<C, InstanceName<C>>,
				IdempotencyIn<C, InstanceName<C>>,
				QueuesIn<C, InstanceName<C>>
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

export type SoleLimits<C> =
	Sole<InstanceName<C>> extends true
		? LimitScope<LimitsIn<C, InstanceName<C>>>
		: never;

export type SoleIdempotency<C> =
	Sole<InstanceName<C>> extends true
		? IdempotencyScope<IdempotencyIn<C, InstanceName<C>>>
		: never;

/** `redis.queues` of a Redis with one instance: that instance's queue scope, `never` with several. */
export type SoleQueues<C> =
	Sole<InstanceName<C>> extends true
		? QueueScope<QueuesIn<C, InstanceName<C>>>
		: never;

/** `lock` names the instance when there is more than one. */
export type RedisLockOptions<C> = LockOptions & {
	/** Which Redis the lock lives on. Required when it holds several. */
	on?: InstanceName<C>;
};

/**
 * An application's Redis wiring: the clients, the caches, the channels and the guards,
 * in one object that closes everything it opened.
 *
 * There is no `as(actor)` and no `withSession`, as `@nxgt/mongo`'s wiring has:
 * Redis has neither an actor to stamp nor a session to carry, so a Redis object is
 * the same object for every request and is never derived.
 */
export interface Redis<C> extends AsyncDisposable {
	/** The caches, when it holds one instance. `never` when it holds several. */
	readonly cache: SoleCache<C>;
	/** The channels, when it holds one instance. `never` when it holds several. */
	readonly channels: SoleChannels<C>;
	/** The rate limits, when it holds one instance. `never` when it holds several. */
	readonly limits: SoleLimits<C>;
	/** The idempotent operations, when it holds one instance. `never` likewise. */
	readonly idempotency: SoleIdempotency<C>;
	/** The queues, when it holds one instance. `never` when it holds several. */
	readonly queues: SoleQueues<C>;
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceScope<
			CachesIn<C, N>,
			ChannelsIn<C, N>,
			LimitsIn<C, N>,
			IdempotencyIn<C, N>,
			QueuesIn<C, N>
		>;
	};
	readonly clients: { readonly [N in InstanceName<C>]: RedisClient };
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: RedisLockOptions<C>,
	): Promise<T>;
	/** Every instance's `ping`, under its name. Never throws. */
	ping(options?: {
		timeoutMs?: number;
	}): Promise<Record<InstanceName<C>, PingResult>>;
	/**
	 * Closes the queues, then every subscription this Redis started, then
	 * every client it opened. A client the configuration handed in is left
	 * alone.
	 *
	 * The queues close in two phases. First `work` is refused with `CLOSED`
	 * and every worker started through `redis.queues` closes: running jobs
	 * finish within `grace`, then their signals abort with `CLOSED`; `add`
	 * still works, so a handler may enqueue a follow-up. Then `add`,
	 * `addMany` and `finished` are refused with `CLOSED`, and each pending
	 * `finished` rejects. Admin calls (`get`, `list`, `counts`, `pause`,
	 * `resume`, `retry`, `remove`, `cancel`) are never refused.
	 *
	 * `grace` is how long a running job gets, per worker; the default is the
	 * worker's own, 30 seconds. A malformed `grace` rejects with a
	 * `TypeError` and closes nothing. A worker whose close fails does not
	 * keep the others, nor the connections, open: the first error is thrown
	 * once everything is closed. Idempotent: a second call returns the
	 * first call's promise, and its `grace` is ignored.
	 */
	close(options?: { grace?: Duration }): Promise<void>;
}

/** The Redis object a `defineRedis` result produces, for an application's own types. */
export type RedisOf<Config> =
	Config extends RedisConfig<infer C> ? Redis<C> : never;

/** A definition as this layer handles it: by key, loosely typed. */
export type AnyCache = CacheDefinition<never, z.ZodType>;
export type AnyChannel = ChannelDefinition<z.ZodType>;
export type AnyRateLimit = RateLimitDefinition<never>;
export type AnyIdempotency = IdempotencyDefinition<never, z.ZodType>;

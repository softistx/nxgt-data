import type { z } from 'zod';
import type { BoundCache } from '../cache/bind-cache';
import type { InputOf, ParamsOf, ValueOf } from '../cache/types';
import type { ChannelDefinition } from '../channel/define-channel';
import type { SubscribeOptions, Subscription } from '../channel/pubsub';
import type { StreamOptions } from '../channel/stream';
import type {
	BoundIdempotency,
	IdempotencyDefinition,
} from '../idempotency/types';
import type { BoundQueue, QueueDefinition } from '../queue/types/queue';
import type { BoundRateLimit, RateLimitDefinition } from '../rate-limit/types';
import type {
	CachesOf,
	ChannelsOf,
	IdempotencyOf,
	LimitsOf,
	QueuesOf,
} from './config/types';

/** What a channel carries, read from the schema it was defined with. */
export type PayloadOf<D> =
	D extends ChannelDefinition<infer S> ? z.output<S> : never;

/**
 * One channel, bound to a client and carrying its prefixed name.
 *
 * `subscribe` is the Redis's, not `@nxgt/redis`'s: it hands back the same
 * `Subscription` — so a caller can still close one early — and also records
 * it, so `redis.close()` closes the ones nobody did. Each subscription holds a
 * duplicated connection, which is what makes a forgotten one cost something.
 */
export interface BoundChannel<D> {
	/**
	 * The definition this was bound with. Wired through `openRedis`, it is
	 * the copy with the prefix in its name, so `definition.name` is the name
	 * that is actually written. Read-only: the wired copy is frozen.
	 */
	readonly definition: D;
	/** The channel's name in Redis, prefix included. */
	readonly name: string;
	/** The number of subscribers Redis handed the message to. Not a delivery
	 * guarantee: pub/sub is fire-and-forget. */
	publish(payload: PayloadOf<D>): Promise<number>;
	subscribe(
		handler: (payload: PayloadOf<D>) => void | Promise<void>,
		options?: SubscribeOptions,
	): Promise<Subscription>;
	/**
	 * The messages whose `key` the definition's selector gives `key`, as an
	 * async iterator (a GraphQL subscription's `subscribe` result as it is).
	 * The process holds ONE Redis subscription for the channel, opened by the
	 * first read and closed when the last iterator leaves; `return()`,
	 * `throw()` and `Symbol.asyncDispose` release an iterator at once, even
	 * while it waits. A reader slower than the publishers loses its oldest
	 * messages past `bufferSize`. Throws a `TypeError` when the definition has
	 * no `key`.
	 */
	stream(
		key: string,
		options?: StreamOptions,
	): AsyncGenerator<PayloadOf<D>, undefined, undefined> & AsyncDisposable;
	/** Stops every stream of this channel and closes their shared subscription. */
	close(): Promise<void>;
}

export type CacheScope<Ca> = {
	readonly [K in keyof CachesOf<Ca>]: BoundCache<
		ParamsOf<CachesOf<Ca>[K]>,
		ValueOf<CachesOf<Ca>[K]>,
		InputOf<CachesOf<Ca>[K]>
	>;
};

export type ChannelScope<Ch> = {
	readonly [K in keyof ChannelsOf<Ch>]: BoundChannel<ChannelsOf<Ch>[K]>;
};

/** What a rate limit's key takes, so a bound limit can ask for it. */
type LimitParams<D> = D extends RateLimitDefinition<infer P> ? P : never;

export type LimitScope<Li> = {
	readonly [K in keyof LimitsOf<Li>]: BoundRateLimit<
		LimitParams<LimitsOf<Li>[K]>
	>;
};

export type IdempotencyScope<Id> = {
	readonly [K in keyof IdempotencyOf<Id>]: IdempotencyOf<Id>[K] extends IdempotencyDefinition<
		infer P,
		infer S
	>
		? BoundIdempotency<P, z.output<S>, z.input<S>>
		: never;
};

/**
 * The wired queues, each typed by its definition: what `add` takes and what
 * `finished` resolves to come from the schema and the result schema.
 */
export type QueueScope<Qu> = {
	readonly [K in keyof QueuesOf<Qu>]: QueuesOf<Qu>[K] extends QueueDefinition<
		infer S,
		infer R
	>
		? BoundQueue<S, R>
		: never;
};

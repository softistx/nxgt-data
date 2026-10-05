import type { RedisClient, RedisOptions } from 'bun';
import type { z } from 'zod';
import type { CacheDefinition } from '../../cache/types';
import type { ChannelDefinition } from '../../channel/define-channel';
import type { IdempotencyDefinition } from '../../idempotency/types';
import type { RateLimitDefinition } from '../../rate-limit/types';

/**
 * The caches of a module object, and nothing else.
 *
 * `import * as caches from './caches'` brings whatever that file exports —
 * types, helpers, a constant. Key remapping keeps the definitions and drops
 * the rest, so an application passes the module as it is.
 */
export type CachesOf<C> = {
	[K in keyof C as C[K] extends CacheDefinition<never, z.ZodType>
		? K
		: never]: C[K];
};

/**
 * The channels of a module object, and nothing else.
 *
 * A `CacheDefinition` is not structurally a channel — `ChannelDefinition`
 * carries `ttl?: never` for exactly this reason — so the two survive being
 * exported from one file.
 */
export type ChannelsOf<C> = {
	[K in keyof C as C[K] extends ChannelDefinition<z.ZodType> ? K : never]: C[K];
};

/**
 * The rate limits of a module object, and nothing else.
 *
 * Not structurally a cache, a channel or an idempotency — it has `limit` and
 * `per`, which they have not — so one file may export several kinds, and each
 * scope keeps its own.
 */
export type LimitsOf<L> = {
	[K in keyof L as L[K] extends RateLimitDefinition<never> ? K : never]: L[K];
};

/** The idempotent operations of a module object, and nothing else. */
export type IdempotencyOf<I> = {
	[K in keyof I as I[K] extends IdempotencyDefinition<never, z.ZodType>
		? K
		: never]: I[K];
};

/** One Redis: where it is, and what is wired on it. */
export interface InstanceConfig<Ca, Ch, Li = object, Id = object> {
	/**
	 * Where to connect. One of `uri` and `client`, never both. Instances on
	 * one URI share a client, which the Redis closes with its last holder.
	 */
	uri?: string;
	/**
	 * A client the application opened. The Redis uses it and **never closes
	 * it**: what it did not open is not its to close.
	 */
	client?: RedisClient;
	/** Passed to the driver with `uri`. Refused with `client`, which has its own. */
	clientOptions?: RedisOptions;
	/**
	 * Put in front of every key this Redis writes: cache keys, channel names,
	 * lock keys, rate-limit keys and idempotency keys alike.
	 *
	 * It belongs here and not in a definition. A definition says what a value
	 * *is*; a prefix says which deployment owns it, which the same definition
	 * cannot know and which changes between environments sharing one Redis.
	 * A cache `sessions` under `myapp:prod` stores `myapp:prod:sessions:<key>`,
	 * and a rate limit `login` stores `myapp:prod:login:<key>`. A guard bound by
	 * hand with `bindRateLimit` has no prefix: moving it here starts new keys.
	 */
	prefix?: string | undefined;
	/** `import * as caches from './caches'`, passed as it is. */
	caches?: Ca;
	/** `import * as channels from './channels'`, passed as it is. */
	channels?: Ch;
	/** `import * as limits from './limits'`, passed as it is. */
	limits?: Li;
	/** `import * as idempotency from './idempotency'`, passed as it is. */
	idempotency?: Id;
}

/** One Redis, or several under their names. */
export type RedisConfigInput =
	| InstanceConfig<object, object>
	| { instances: Record<string, InstanceConfig<object, object>> };

/** The instances of a config, whichever shape it was written in. */
export type InstancesOf<C> = C extends { instances: infer I }
	? I
	: { default: C };

export type InstanceName<C> = keyof InstancesOf<C> & string;

export type CachesIn<C, N extends InstanceName<C>> = InstancesOf<C>[N] extends {
	caches: infer Ca;
}
	? Ca
	: Record<never, never>;

export type ChannelsIn<
	C,
	N extends InstanceName<C>,
> = InstancesOf<C>[N] extends { channels: infer Ch }
	? Ch
	: Record<never, never>;

export type LimitsIn<C, N extends InstanceName<C>> = InstancesOf<C>[N] extends {
	limits: infer Li;
}
	? Li
	: Record<never, never>;

export type IdempotencyIn<
	C,
	N extends InstanceName<C>,
> = InstancesOf<C>[N] extends { idempotency: infer Id }
	? Id
	: Record<never, never>;

/**
 * A key the configuration does not have, turned into a message.
 *
 * `defineRedis` infers its argument, so a plain object literal does not get
 * TypeScript's excess-property check: the literal *is* the inferred type, and
 * nothing is in excess of itself. The constraint is therefore written as
 * `config: C & Checked<C>`, which makes the refusal land on the key the
 * application wrote rather than on the whole object. `@nxgt/mongo`'s wiring does
 * the same, for the same reason.
 */
type NoExtraKeys<C, Known extends string> = {
	[K in Exclude<keyof C, Known>]: `"${K & string}" is not an option here`;
};

/** The single-instance shape, with its own keys and nothing else. */
type CheckedInstance<C> = NoExtraKeys<
	C,
	| 'uri'
	| 'client'
	| 'clientOptions'
	| 'prefix'
	| 'caches'
	| 'channels'
	| 'limits'
	| 'idempotency'
>;

/**
 * The whole configuration: either `{ instances }` alone, or one instance
 * written as the configuration itself.
 */
export type Checked<C> = C extends { instances: infer I }
	? NoExtraKeys<C, 'instances'> & {
			instances: { [N in keyof I]: CheckedInstance<I[N]> };
		}
	: CheckedInstance<C>;

/**
 * What `defineRedis` gives back: the same instances, named and frozen.
 *
 * Always keyed, even when the application wrote the single shape — that one
 * is normalised to the name `default`, so everything below has one case.
 */
export interface RedisConfig<C> {
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceConfig<
			CachesIn<C, N>,
			ChannelsIn<C, N>,
			LimitsIn<C, N>,
			IdempotencyIn<C, N>
		>;
	};
}

import type { CacheDefinition, ChannelDefinition } from '@nxgt/redis';
import type { RedisClient, RedisOptions } from 'bun';
import type { z } from 'zod';

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

/** One Redis: where it is, and what is wired on it. */
export interface InstanceConfig<Ca, Ch> {
	/**
	 * Where to connect. One of `uri` and `client`, never both. Instances on
	 * one URI share a client, which the kit closes with its last holder.
	 */
	uri?: string;
	/**
	 * A client the application opened. The kit uses it and **never closes
	 * it**: what it did not open is not its to close.
	 */
	client?: RedisClient;
	/** Passed to the driver with `uri`. Refused with `client`, which has its own. */
	clientOptions?: RedisOptions;
	/**
	 * Put in front of every key this kit writes: cache keys, channel names
	 * and lock keys alike.
	 *
	 * It belongs here and not in a definition. A definition says what a value
	 * *is*; a prefix says which deployment owns it, which the same definition
	 * cannot know and which changes between environments sharing one Redis.
	 * A cache `sessions` under `myapp:prod` stores `myapp:prod:sessions:<key>`.
	 */
	prefix?: string;
	/** `import * as caches from './caches'`, passed as it is. */
	caches?: Ca;
	/** `import * as channels from './channels'`, passed as it is. */
	channels?: Ch;
}

/** One Redis, or several under their names. */
export type KitConfigInput =
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

/**
 * A key the configuration does not have, turned into a message.
 *
 * `defineConfig` infers its argument, so a plain object literal does not get
 * TypeScript's excess-property check: the literal *is* the inferred type, and
 * nothing is in excess of itself. The constraint is therefore written as
 * `config: C & Checked<C>`, which makes the refusal land on the key the
 * application wrote rather than on the whole object. `@nxgt/mongo-kit` does
 * the same, for the same reason.
 */
type NoExtraKeys<C, Known extends string> = {
	[K in Exclude<keyof C, Known>]: `"${K & string}" is not an option here`;
};

/** The single-instance shape, with its own keys and nothing else. */
type CheckedInstance<C> = NoExtraKeys<
	C,
	'uri' | 'client' | 'clientOptions' | 'prefix' | 'caches' | 'channels'
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
 * What `defineConfig` gives back: the same instances, named and frozen.
 *
 * Always keyed, even when the application wrote the single shape — that one
 * is normalised to the name `default`, so everything below has one case.
 */
export interface KitConfig<C> {
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceConfig<
			CachesIn<C, N>,
			ChannelsIn<C, N>
		>;
	};
}

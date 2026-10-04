import {
	defineRedis,
	openRedis,
	type Redis,
	type RedisConfig,
	type RedisConfigInput,
	type RedisLockOptions,
	type RedisOf,
} from '@nxgt/redis';

// This package moved into `@nxgt/redis`. Every name below is that package's,
// re-exported; the ones that were renamed keep their old spelling as a
// deprecated alias until the next major.

export type {
	BoundChannel,
	CacheScope,
	CachesIn,
	CachesOf,
	ChannelScope,
	ChannelsIn,
	ChannelsOf,
	InstanceConfig,
	InstanceName,
	InstanceScope,
	InstancesOf,
	PayloadOf,
	SoleCache,
	SoleChannels,
	SoleInstance,
} from '@nxgt/redis';

/** @deprecated Use openRedis from @nxgt/redis */
export const connectKit = openRedis;

/** @deprecated Use defineRedis from @nxgt/redis */
export const defineConfig = defineRedis;

/** @deprecated Use Redis from @nxgt/redis */
export type RedisKit<C> = Redis<C>;

/** @deprecated Use RedisOf from @nxgt/redis */
export type KitOf<Config> = RedisOf<Config>;

/** @deprecated Use RedisConfig from @nxgt/redis */
export type KitConfig<C> = RedisConfig<C>;

/** @deprecated Use RedisConfigInput from @nxgt/redis */
export type KitConfigInput = RedisConfigInput;

/** @deprecated Use RedisLockOptions from @nxgt/redis */
export type KitLockOptions<C> = RedisLockOptions<C>;

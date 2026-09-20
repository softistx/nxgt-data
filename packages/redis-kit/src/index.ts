export { defineConfig } from './config/define-config';
export type {
	CachesIn,
	CachesOf,
	ChannelsIn,
	ChannelsOf,
	InstanceConfig,
	InstanceName,
	InstancesOf,
	KitConfig,
	KitConfigInput,
} from './config/types';
export { connectKit } from './kit/connect-kit';
export type {
	BoundChannel,
	CacheScope,
	ChannelScope,
	InstanceScope,
	KitLockOptions,
	KitOf,
	PayloadOf,
	RedisKit,
	SoleCache,
	SoleChannels,
	SoleInstance,
} from './kit/types';

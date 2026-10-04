# @nxgt/redis-kit

> **Deprecated.** This package moved into
> [`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis), which now holds
> the whole API under shorter names. `@nxgt/redis-kit` only re-exports it, with
> the old names marked `@deprecated`, and will not grow.

## What was renamed

| `@nxgt/redis-kit` | `@nxgt/redis` |
| --- | --- |
| `connectKit` | `openRedis` |
| `defineConfig` | `defineRedis` |
| `RedisKit<C>` | `Redis<C>` |
| `KitOf` | `RedisOf` |
| `KitConfig` / `KitConfigInput` | `RedisConfig` / `RedisConfigInput` |
| `KitLockOptions<C>` | `RedisLockOptions<C>` |

Everything else keeps its name: `CachesIn`, `CachesOf`, `ChannelsIn`,
`ChannelsOf`, `InstanceConfig`, `InstanceName`, `InstancesOf`, `BoundChannel`,
`CacheScope`, `ChannelScope`, `InstanceScope`, `PayloadOf`, `SoleCache`,
`SoleChannels` and `SoleInstance`.

**What else changed in the move:** the messages begin with `defineRedis:` and
`openRedis:` instead of `defineConfig:` and `connectKit:`, and the two
refusals that named a call read `cache: this Redis holds 2 Redis instances, …`
and `lock: this Redis has no instance named "…"` instead of `kit.cache: this
kit holds …`. A test that matches one of those messages has to change with
them, whichever package it imports from.

## Moving over

```ts
// before
import { connectKit, defineConfig } from '@nxgt/redis-kit';

export const kit = await connectKit(
	defineConfig({ uri: process.env.REDIS_URL!, caches, channels }),
);
await kit.cache.users.remember(id, () => loadUser(id));
```

```ts
// after
import { defineRedis, openRedis } from '@nxgt/redis';

export const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, caches, channels }),
);
await redis.cache.users.remember(id, () => loadUser(id));
```

The configuration, the scopes, the lock, `ping` and `close()` are unchanged;
only the names above differ. The guides are in
[`@nxgt/redis`](https://github.com/softistx/nxgt-data/tree/develop/packages/redis/docs/guide/wiring).

## Install

```sh
bun add @nxgt/redis-kit @nxgt/redis zod
```

`@nxgt/redis` is a required peer, and so are `zod` and `typescript` through it.

## License

MIT

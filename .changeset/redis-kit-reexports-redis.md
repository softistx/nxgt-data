---
"@nxgt/redis-kit": minor
---

`@nxgt/redis-kit` is deprecated: its API moved into `@nxgt/redis`, and this package now only re-exports it. `@nxgt/redis` is its one peer besides `typescript` (`zod` comes with it), and the docs are gone from the package — they live in `@nxgt/redis`.

Every renamed name keeps its old spelling as a `@deprecated` alias: `connectKit` is `openRedis`, `defineConfig` is `defineRedis`, and `RedisKit`, `KitOf`, `KitConfig`, `KitConfigInput` and `KitLockOptions` are `Redis`, `RedisOf`, `RedisConfig`, `RedisConfigInput` and `RedisLockOptions`; the names that did not change are re-exported as they were.

**What changes for a caller:** the messages and the `name`s follow `@nxgt/redis`. A refusal begins `defineRedis:` or `openRedis:` instead of `defineConfig:` or `connectKit:`; `kit.cache: this kit holds 2 Redis instances, …` is now `cache: this Redis holds 2 Redis instances, …`, and `kit.lock: this kit has no instance named …` is `lock: this Redis has no instance named …`. A test that matches one of those has to change. Move to `@nxgt/redis` when you can: `bun add @nxgt/redis`, then rename as above.

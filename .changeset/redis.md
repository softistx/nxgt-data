---
"@nxgt/redis": minor
---

Redis on Bun's own `RedisClient`, with no third-party driver: `connectRedis` /
`closeRedis` sharing one client per URI, `defineCache` / `bindCache` whose key
is built by a typed function and whose value is checked by its schema both
ways, `withLock` over `SET NX PX` released by a compare-and-delete script, and
`defineChannel` / `publish` / `subscribe` typed the same way. Its one error is
`RedisError`.

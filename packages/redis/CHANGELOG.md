# @nxgt/redis

## 0.1.0

### Minor Changes

- [#45](https://github.com/softistx/nxgt-data/pull/45) [`f3b1703`](https://github.com/softistx/nxgt-data/commit/f3b1703e2fd76396c92e84fda4dab771ca6287d4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Redis on Bun's own `RedisClient`, with no third-party driver: `connectRedis` /
  `closeRedis` sharing one client per URI, `defineCache` / `bindCache` whose key
  is built by a typed function and whose value is checked by its schema both
  ways, `withLock` over `SET NX PX` released by a compare-and-delete script, and
  `defineChannel` / `publish` / `subscribe` typed the same way. Its one error is
  `RedisError`.

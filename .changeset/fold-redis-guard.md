---
"@nxgt/redis": minor
---

The rate limits and the idempotency of `@nxgt/redis-guard` are now in this package, exported from the root and **not renamed**. New exports: `defineRateLimit`, `bindRateLimit`, `defineIdempotency`, `bindIdempotency`, and the error `GuardError` with its codes `GuardErrorCode` (`RATE_LIMITED`, `COST`, `IN_PROGRESS`, `MISMATCH`, `INVALID`, `LEASE_LOST`). The types come with them: `RateLimitDefinition`, `BoundRateLimit`, `LimitResult`, `IdempotencyDefinition`, `BoundIdempotency`, `Idempotent` and `RunOptions`. Each takes any Bun `RedisClient` — the `client` of a connection or of `openRedis`, or your own — and every message is what `@nxgt/redis-guard` 0.3.2 gave. `GuardError` stays its own class, apart from `RedisError`. Nothing existing changes. The guides, the troubleshooting entries and the roadmap moved here with it, and the README has a section on each.

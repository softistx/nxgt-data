---
'@nxgt/redis-guard': minor
---

First release of `@nxgt/redis-guard`, guards on Bun's own `RedisClient`, starting with rate limits. `defineRateLimit({ name, key, limit, per, burst })` describes a limit and `bindRateLimit(client, definition)` binds it, with `consume`, `enforce`, `peek` and `reset`, and an optional `cost` per call. Each check is GCRA as one Lua script over one key, sent by its SHA-1 and falling back to `EVAL` on `NOSCRIPT`. The script is timed by the Redis server's `TIME`, never the host's clock. A denial and a `peek` write nothing, and the key expires when its bucket is full again. A rate faster than 500 requests a millisecond is refused at definition, since the script counts in microseconds. Every result is a delay in milliseconds (`resetAfter`, `retryAfter`), never a date. Its error is `GuardError`, with `RATE_LIMITED` (carrying `retryAfter`) and `COST`, naming the definition and never the key or the params.

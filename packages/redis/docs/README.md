# `@nxgt/redis` documentation

Redis on Bun's own `RedisClient`. There is no third-party driver to install —
`RedisClient` is built into Bun — which is also why this package does not run
on Node. Its only peers are `zod` and `typescript`.

The same package holds the guards: rate limits and idempotent operations,
each one atomic script on the server, timed by the server's clock, on any Bun
`RedisClient` — the one `openRedis` opened, or your own.

Start with the **wiring** pages if you want the whole thing in one object —
`defineRedis` and `openRedis`, with every cache and channel typed under the
name it is exported as — and with the lower-level pages (connections, caches,
locks, pub/sub) for the pieces it is made of. The rate-limit and idempotency
pages are under `guide/guard/`.

| Page | Read it when |
| --- | --- |
| [Wiring: configuration](guide/wiring/configuration.md) | you are describing where Redis is and what is wired on it with `defineRedis`, and deciding what the deployment's prefix should be |
| [Wiring: caches](guide/wiring/caches.md) | you are reading `redis.cache.users`, and want the keys it writes, what `remember` promises, and what the types refuse |
| [Wiring: channels](guide/wiring/channels.md) | one process publishes an event and another reacts to it, and somebody has to close the subscription |
| [Wiring: locks and health](guide/wiring/locks-and-health.md) | a job must run once, or a health route has to say whether Redis answers |
| [Wiring: instances and closing](guide/wiring/instances.md) | an application talks to more than one Redis, or you are deciding who closes which client |
| [Connections](guide/connections.md) | you are opening a client, sharing it between modules, checking its health, or closing it on shutdown |
| [Caches](guide/cache.md) | you want a value kept for a while, keyed by what identifies it and checked against a schema both ways |
| [Locks](guide/locks.md) | one job, one worker: a cron that must not run twice, a migration, anything that must happen once |
| [Pub/sub](guide/channels.md) | one process publishes an event and others react to it, with the payload typed by a schema |
| [Rate limits](guide/guard/rate-limits.md) | you want to hold a caller to so many requests per window — logins per address, exports per user — with the algorithm, choosing `burst`, costs, and an HTTP recipe for any framework |
| [Idempotency](guide/guard/idempotency.md) | an operation must happen once per client key however often it is retried — an order, a charge — with the fingerprint, the lease and its heartbeat, waiting for a running key with `wait`, `ttl` and `lease`, changing the schema, the storage, and an HTTP recipe for the `Idempotency-Key` header in any framework |
| [Testing rate limits and idempotency](guide/guard/testing.md) | you are writing `bun test` specs for code that uses a limit or an idempotent operation: a real Redis, emptying it between specs, and why moving the clock refills nothing |
| [Upgrading from `@nxgt/redis-guard`](guide/guard/upgrading.md) | you are on `@nxgt/redis-guard` 0.2 or earlier: installing `zod`, shortening `lease`, matching on `code`, and a rolling deploy |
| [Troubleshooting](troubleshooting.md) | a call threw — a `RedisError` or a `GuardError` — a connect hung, a cached value came back `undefined`, a limit allows more or less than you expected, or the same request ran twice, and you want the reason |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, one example per
area, and the traps in one line each.

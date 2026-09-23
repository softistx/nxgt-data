# `@nxgt/redis-guard` documentation

Guards on Bun's own `RedisClient`, each one a single atomic script on the
server, timed by the server's clock. There is no driver to install —
`RedisClient` is built into Bun — which is also why this package does not run
on Node. Its peers are `typescript` and, since 0.2.0, `zod`, whose types
describe the schema you pass to check an idempotent result.

| Page | Read it when |
| --- | --- |
| [Rate limits](guide/rate-limits.md) | you want to hold a caller to so many requests per window — logins per address, exports per user — with the algorithm, choosing `burst`, costs, and an HTTP recipe for any framework |
| [Idempotency](guide/idempotency.md) | an operation must happen once per client key however often it is retried — an order, a charge — with the fingerprint, the lease and its heartbeat, waiting for a running key with `wait`, `ttl` and `lease`, changing the schema, the storage, and an HTTP recipe for the `Idempotency-Key` header in any framework |
| [Testing](guide/testing.md) | you are writing `bun test` specs for code that uses a limit or an idempotent operation: a real Redis, emptying it between specs, and why moving the clock refills nothing |
| [Upgrading](upgrading.md) | you are moving from 0.1.0 or 0.2.0: installing `zod`, shortening `lease`, matching on `code`, and a rolling deploy |
| [Troubleshooting](troubleshooting.md) | a call threw, `tsc` cannot find `bun` or `zod`, Redis is unreachable, a limit allows more or less than you expected, or the same request ran twice |
| [Roadmap](roadmap.md) | you want to know what is coming, what has shipped in which version, and what has been ruled out |

The [README](../README.md) is the short version: install, an example for
each primitive, the API, the errors and the traps.

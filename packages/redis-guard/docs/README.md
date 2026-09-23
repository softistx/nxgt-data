# `@nxgt/redis-guard` documentation

Guards on Bun's own `RedisClient`, each one a single atomic script on the
server, timed by the server's clock. There is no driver to install —
`RedisClient` is built into Bun — which is also why this package does not run
on Node. Its peers are `typescript` and, since 0.2.0, `zod`, which checks an
idempotent result.

| Page | Read it when |
| --- | --- |
| [Rate limits](guide/rate-limits.md) | you want to hold a caller to so many requests per window — logins per address, exports per user — with the algorithm, choosing `burst`, costs, and an HTTP recipe for any framework |
| [Idempotency](guide/idempotency.md) | an operation must happen once per client key however often it is retried — an order, a charge — with the fingerprint, `ttl` and `lease`, changing the schema, the storage, and an HTTP recipe for the `Idempotency-Key` header in any framework |
| [Troubleshooting](troubleshooting.md) | a call threw, a limit allows more or less than you expected, or the same request ran twice |
| [Roadmap](roadmap.md) | you want to know what is coming — a lease heartbeat and `wait` next — and what has been ruled out |

The [README](../README.md) is the short version: install, one example, the
API, and the traps in one line each.

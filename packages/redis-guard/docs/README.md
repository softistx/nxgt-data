# `@nxgt/redis-guard` documentation

Guards on Bun's own `RedisClient`, each one a single atomic script on the
server, timed by the server's clock. There is no driver to install —
`RedisClient` is built into Bun — which is also why this package does not run
on Node. Its only peer is `typescript`.

| Page | Read it when |
| --- | --- |
| [Rate limits](guide/rate-limits.md) | you want to hold a caller to so many requests per window — logins per address, exports per user — with the algorithm, choosing `burst`, costs, and an HTTP recipe for any framework |
| [Troubleshooting](troubleshooting.md) | a call threw, or a limit allows more, or less, than you expected |
| [Roadmap](roadmap.md) | you want to know what is coming — idempotency next — and what has been ruled out |

The [README](../README.md) is the short version: install, one example, the
API, and the traps in one line each.

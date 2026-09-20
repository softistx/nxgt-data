# `@nxgt/redis` documentation

Redis on Bun's own `RedisClient`. There is no third-party driver to install —
`RedisClient` is built into Bun — which is also why this package does not run
on Node. Its only peers are `zod` and `typescript`.

| Page | Read it when |
| --- | --- |
| [Connections](guide/connections.md) | you are opening a client, sharing it between modules, checking its health, or closing it on shutdown |
| [Caches](guide/cache.md) | you want a value kept for a while, keyed by what identifies it and checked against a schema both ways |
| [Locks](guide/locks.md) | one job, one worker: a cron that must not run twice, a migration, anything that must happen once |
| [Pub/sub](guide/channels.md) | one process publishes an event and others react to it, with the payload typed by a schema |
| [Troubleshooting](troubleshooting.md) | a call threw, a connect hung, or a cached value came back `undefined` and you want the reason |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, one example per
area, and the traps in one line each.

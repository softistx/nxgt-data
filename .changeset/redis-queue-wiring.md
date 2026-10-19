---
'@nxgt/redis': minor
---

Queues are wired like caches and guards: `defineRedis({ queues })` (and `openRedis`) gives `redis.queues.<key>` under the deployment's prefix, and `redis.close({ grace })` closes their workers first. Once the Redis is closed, a queue refuses `add`, `addMany`, `work` and `finished` (pending ones too) with `QueueError` `CLOSED`; admin calls (`get`, `list`, `counts`, `retry`, `remove`, `cancel`) still pass through. Two things are refused when queues are wired: a prefix with braces, and a queue name shared with a cache, a rate limit or an idempotency. `job.key` carries the prefix: `<prefix>:<queue>:<id>:<step>`.

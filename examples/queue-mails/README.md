# queue-mails (example)

A SaaS sends its tenants' mails through [`@nxgt/redis`](../../packages/redis)'s
queues, with a producer and a worker as separate entry points. It is not
published. Its guide is [Queues](../../packages/redis/docs/guide/queues.md).

| File | What it shows |
| --- | --- |
| `src/mails.ts` | `defineQueue`: a schema-checked payload and result, `groups: { concurrency: 2 }` per tenant, and the nightly digest as a `schedules` cron in `Europe/Paris` |
| `src/redis.ts` | `defineRedis({ queues })`: the queue wired under the `saas` prefix, `AppRedis` read from it |
| `src/producer.ts` | `addWelcome`: an `add` with `group: tenantId` |
| `src/worker.ts` | the handler: a `send` step whose `job.key('send')` is the provider's idempotency key, then a `record` step; `serve` closes on SIGTERM/SIGINT and lets running jobs finish |
| `src/env.ts` | the environment, parsed once with zod |

The provider (`sendMail`) is injected, so the spec observes it; the CLI worker
only logs. `bun run producer <tenantId> <to>` queues a welcome, `bun run worker`
works until a signal. `REDIS_URL` names the Redis (default `redis://127.0.0.1:6379`).
The spec runs against a real Redis started from `$REDIS_BIN` (`bun run test`).

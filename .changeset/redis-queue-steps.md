---
'@nxgt/redis': minor
---

Queue handlers get durable steps: `job.step(name, fn)` commits a side effect's value once per job, fenced against a stale worker, so a retry gets the stored value back instead of running `fn` again. `fn` may still run more than once (a crash, or a lease lapsing mid-step), so `job.key(name)` gives a stable idempotency key to hand downstream.

A queue name cannot hold `:`, so `job.key` is unambiguous: `defineQueue` throws a `TypeError` for one.

`StepOptions` is exported. `finished({ timeout })` is a hard bound: it rejects `WAIT_TIMEOUT` on time even when a connection hangs.

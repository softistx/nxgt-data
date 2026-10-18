---
'@nxgt/redis': minor
---

Queue handlers get durable steps: `job.step(name, fn)` runs a side effect once per job, not once per attempt, fenced against a stale worker, and `job.key(name)` gives a stable idempotency key.

`StepOptions` is exported. `finished({ timeout })` is now a hard bound: it rejects `WAIT_TIMEOUT` on time even when a connection hangs.

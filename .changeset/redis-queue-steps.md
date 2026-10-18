---
'@nxgt/redis': minor
---

Queue handlers get durable steps: `job.step(name, fn)` runs a side effect once per job, not once per attempt, fenced against a stale worker, and `job.key(name)` gives a stable idempotency key.

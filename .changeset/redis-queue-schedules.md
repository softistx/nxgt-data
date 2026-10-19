---
'@nxgt/redis': minor
---

Queues run recurring jobs. A schedule is a five-field cron with an optional IANA time zone, or an `every` interval, and it is declared in `defineQueue({ schedules })` or managed at run time with `queue.schedules.upsert`, `remove` and `list`. A worker fires each schedule that is due as the job `schedule:<id>:<ms>`, exactly once across processes, and an outage fires the missed occurrence once rather than once per missed tick. Static schedules are synced when a queue's first worker starts: one that leaves the definition is removed, and runtime schedules are never touched. Schedules fire while a queue is paused, and nothing fires while no worker runs.

A job id given to `add` cannot start with `schedule:`, which names scheduled occurrences.

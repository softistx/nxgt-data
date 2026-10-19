---
'@nxgt/redis': minor
---

`retry(id, { fresh: true })` clears a failed job's stored step values, so every `job.step` runs again; `retry(id)` still resumes after the last finished step. `job.key(name)` is the same either way. A `fresh` that is not `true` or `false` is a `TypeError`. New type: `RetryOptions`.

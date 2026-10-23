---
"@nxgt/redis": patch
---

`queue.get` and `queue.list` no longer show `NaN` for a job hash written by something else: a hash whose `attempt`, `attempts`, `priority` or `progress` is missing or not a number is `undefined` (skipped by `list`), as a hash with no known `state` already was.

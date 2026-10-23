---
"@nxgt/redis": patch
---

`queue.get` and `queue.list` no longer show `NaN` for a job hash written by something else: a hash with an `attempt`, `attempts` or `priority` missing or not whole digits, or a `progress` that is not finite, is `undefined` (skipped by `list`), as a hash with no known `state` already was.

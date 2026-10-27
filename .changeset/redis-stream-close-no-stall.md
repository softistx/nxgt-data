---
'@nxgt/redis': patch
---

A keyed stream channel's `close()` (and `redis.close()`) no longer waits for a subscribe attempt still in flight against an unreachable Redis, which took about 31 s. The iterators end at once, and a subscription that resolves late is closed in the background.

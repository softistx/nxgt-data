---
'@nxgt/redis': patch
---

A keyed stream's first `next()` no longer waits for the subscribe attempt: with `fallback: 'local'` and Redis unreachable, a message published locally reaches the reader at once instead of after about 31 s. The subscription opens in the background.

---
"@nxgt/redis": patch
---

The refusal of a queue that shares its name with a cache, a rate limit or an idempotency no longer says they would share every key in Redis, which a queue's `queue:{<name>}:` keys do not: it says one name means one thing on an instance.

---
'@nxgt/redis': minor
---

Bound caches, rate limits and idempotency expose their `definition`, read-only: `redis.limits.api.definition.limit`, `.per`, `.ttl`, `.lease`. A consumer handed a bound guard no longer needs the definition passed a second time. Bound by hand it is the given definition; wired through `openRedis` it is a frozen copy with the prefix in its name, so `definition.name` is the name actually written. A wired channel carries it too. Additive: the bound types stay as loose in their parameter as before, so `BoundRateLimit<{ ip: string }>` still assigns to `BoundRateLimit<unknown>`.

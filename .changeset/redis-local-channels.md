---
'@nxgt/redis': minor
---

Add `localChannels({ channels })`: binds channel definitions to an in-process transport with the wiring's `publish`, `subscribe`, `stream(key)` and `close()` surface, schema-checked both ways, with no Redis client. For development runs, specs and single-process apps without `REDIS_URL`.

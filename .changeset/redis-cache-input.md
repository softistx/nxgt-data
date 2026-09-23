---
'@nxgt/redis': minor
'@nxgt/redis-kit': minor
---

A cache value is written as the schema accepts it. `set` and a `remember` loader take `z.input` of the cache's schema, so a field with a `.default()` may be left out — `set('u1', { id, email })` where `seats` defaults to 1 — and the default is what gets stored and what every reader gets back; `get` and `remember` still return `z.output`. `BoundCache` gains a third parameter, `I`, defaulting to `T`, and `InputOf<D>` names the written shape. `@nxgt/redis-kit`'s `kit.cache.<key>` is typed through.

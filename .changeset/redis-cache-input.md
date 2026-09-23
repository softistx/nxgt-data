---
'@nxgt/redis': minor
'@nxgt/redis-kit': minor
---

A cache value is written as the schema accepts it. `set` and a `remember` loader take `z.input` of the cache's schema, so a field with a `.default()` may be left out — `set('u1', { id, email })` where `seats` defaults to 1 — and the default is what gets stored and what every reader gets back; `get` and `remember` still return `z.output`. `BoundCache` gains a third parameter, `I`, defaulting to `T`, and `InputOf<D>` names the written shape. `@nxgt/redis-kit`'s `kit.cache.<key>` is typed through.

**What stops compiling**, for a schema whose transform changes a type: passing a value read back (the output) to `set` — which already failed at run time where input and output share nothing, but compiled and worked where they overlap, as with `z.string().transform((s) => (s === '' ? null : s))` — and an explicit `BoundCache<P, ValueOf<D>>` annotation on such a cache, which now wants `BoundCache<P, ValueOf<D>, InputOf<D>>`. Schemas with `.default()` only, `.readonly()`, or transforms that add fields are unaffected. Where a field's input is `unknown` (`z.coerce`, `z.preprocess`), `set` is now checked at run time only.

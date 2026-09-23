---
'@nxgt/redis': patch
---

The troubleshooting entry for `Argument of type 'Date' is not assignable to parameter of type 'string'.` now has a complete Fix snippet. It declares the cache, the bound `seen`, `raw` and `loadRaw` that it used to leave undeclared, so it can be copied and typechecked as it is. The docs say a `z.coerce.number()` field takes any value but still needs its key, and that a whole `z.preprocess` schema takes anything. Both claims are now `@ts-expect-error` and positive cases in the type tests of `@nxgt/redis` and `@nxgt/redis-kit`. Nothing public moved.

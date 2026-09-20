---
'@nxgt/redis': patch
---

`ValueOf<D>` gives a definition's value again, instead of `never`.

`CacheDefinition<P, S>` is **contravariant** in `P` — `key` takes the
parameters — so under `strictFunctionTypes` a `CacheDefinition<string, …>` is
not assignable to one of `unknown`. `ValueOf` matched
`CacheDefinition<unknown, infer S>`, which therefore failed for every
definition whose key took anything narrower than `unknown`: in practice, all
of them. It now matches `CacheDefinition<never, infer S>`, the bottom of that
ordering, so every definition matches.

`ParamsOf` was never affected. Both are now pinned by type tests.

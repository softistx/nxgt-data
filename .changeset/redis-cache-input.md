---
'@nxgt/redis': minor
'@nxgt/redis-kit': minor
---

A cache value is written as the schema accepts it. `set` and a `remember` loader take `z.input` of the cache's schema, so a field with a `.default()` may be left out — `set('u1', { id, email })` where `seats` defaults to 1 — and the default is what gets stored and what every reader gets back; `get` and `remember` still return `z.output`. `BoundCache` gains a third parameter, `I`, defaulting to `T`, and `InputOf<D>` names the written shape. `@nxgt/redis-kit`'s `kit.cache.<key>` is typed through.

**What stops compiling**, only for a schema whose transform changes a type:

- a value read back (the output) passed to `set`. Where input and output share nothing, as with `z.string().transform((s) => new Date(s))`, that already failed at run time; where they overlap, as with `z.string().transform((s) => (s === '' ? null : s))`, it compiled and worked, and now fails with `Argument of type 'string | null' is not assignable to parameter of type 'string'`. Pass the input instead.
- a `remember` loader that returns the output, such as `async () => schema.parse(raw)` on the string → `Date` schema above: `Type 'Date' is not assignable to type 'string'`. Return the input, `raw`, checked with `schema.safeParse(raw)` if it must be checked at the source; the cache parses it anyway.
- an explicit `BoundCache<P, ValueOf<D>>` annotation, only where input and output do not overlap, as with string → `Date`: it now wants `BoundCache<P, ValueOf<D>, InputOf<D>>`. With an overlapping transform such as `'' → null` the two-argument annotation still compiles, because method parameters are checked bivariantly, and only a read-back value passed straight to `set` fails.

Schemas with `.default()` only, `.readonly()`, or transforms that add fields are unaffected. Where a field's input is `unknown`, as with `z.coerce.number()`, that field accepts any value but its key is still required; a whole `z.preprocess` schema accepts anything. There, `set` is checked at run time only, by the schema.

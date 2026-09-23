# @nxgt/redis

## 0.3.1

### Patch Changes

- [#109](https://github.com/softistx/nxgt-data/pull/109) [`546eceb`](https://github.com/softistx/nxgt-data/commit/546eceb7234bce77b1c03ec10fde02ac7b60cb5a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The troubleshooting entry for `Argument of type 'Date' is not assignable to parameter of type 'string'.` now has a complete Fix snippet. It declares the cache, the bound `seen`, `raw` and `loadRaw` that it used to leave undeclared, so it can be copied and typechecked as it is. The docs say a `z.coerce.number()` field takes any value but still needs its key, and that a whole `z.preprocess` schema takes anything. Both claims are now `@ts-expect-error` and positive cases in the type tests of `@nxgt/redis` and `@nxgt/redis-kit`. Nothing public moved.

## 0.3.0

### Minor Changes

- [#92](https://github.com/softistx/nxgt-data/pull/92) [`6b3d0bc`](https://github.com/softistx/nxgt-data/commit/6b3d0bc497a17d6cb085437572f8a4b3fce685dc) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A cache value is written as the schema accepts it. `set` and a `remember` loader take `z.input` of the cache's schema, so a field with a `.default()` may be left out — `set('u1', { id, email })` where `seats` defaults to 1 — and the default is what gets stored and what every reader gets back; `get` and `remember` still return `z.output`. `BoundCache` gains a third parameter, `I`, defaulting to `T`, and `InputOf<D>` names the written shape. `@nxgt/redis-kit`'s `kit.cache.<key>` is typed through.
  
  **What stops compiling**, only for a schema whose transform changes a type:
  
  - a value read back (the output) passed to `set`. Where input and output share nothing, as with `z.string().transform((s) => new Date(s))`, that already failed at run time; where they overlap, as with `z.string().transform((s) => (s === '' ? null : s))`, it compiled and worked, and now fails with `Argument of type 'string | null' is not assignable to parameter of type 'string'`. Pass the input instead.
  - a `remember` loader that returns the output, such as `async () => schema.parse(raw)` on the string → `Date` schema above: `Type 'Date' is not assignable to type 'string'`. Return the input, `raw`, checked with `schema.safeParse(raw)` if it must be checked at the source; the cache parses it anyway.
  - an explicit `BoundCache<P, ValueOf<D>>` annotation, only where input and output do not overlap, as with string → `Date`: it now wants `BoundCache<P, ValueOf<D>, InputOf<D>>`. With an overlapping transform such as `'' → null` the two-argument annotation still compiles, because method parameters are checked bivariantly, and only a read-back value passed straight to `set` fails.
  
  Schemas with `.default()` only, `.readonly()`, or transforms that add fields are unaffected. Where a field's input is `unknown`, as with `z.coerce.number()`, that field accepts any value but its key is still required; a whole `z.preprocess` schema accepts anything. There, `set` is checked at run time only, by the schema.

## 0.2.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The connection failures are a `RedisError` too, with a code.
  
  `RedisErrorCode` gains two: `CONNECTION`, for a `connectRedis` the shared
  client was closed under, and `PING_TIMEOUT`, which `ping` reports on its
  result rather than throwing. Both used to be a bare `Error`, so one class and
  one `code` now cover everything this package refuses; Redis's own failures
  still come back as they are, from Bun's client.
  
  ```ts
  if (error instanceof RedisError && error.code === 'CONNECTION') { … }
  ```
  
  **Neither prints the URI.** `key` is the empty string for both — it names a
  key or a channel, and these are about the connection, not one key. A
  connection string holds the password, and a spec asserts the URI is absent
  from the message.

## 0.1.1

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `ValueOf<D>` gives a definition's value again, instead of `never`.
  
  `CacheDefinition<P, S>` is **contravariant** in `P` — `key` takes the
  parameters — so under `strictFunctionTypes` a `CacheDefinition<string, …>` is
  not assignable to one of `unknown`. `ValueOf` matched
  `CacheDefinition<unknown, infer S>`, which therefore failed for every
  definition whose key took anything narrower than `unknown`: in practice, all
  of them. It now matches `CacheDefinition<never, infer S>`, the bottom of that
  ordering, so every definition matches.
  
  `ParamsOf` was never affected. Both are now pinned by type tests.

## 0.1.0

### Minor Changes

- [#45](https://github.com/softistx/nxgt-data/pull/45) [`f3b1703`](https://github.com/softistx/nxgt-data/commit/f3b1703e2fd76396c92e84fda4dab771ca6287d4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Redis on Bun's own `RedisClient`, with no third-party driver: `connectRedis` /
  `closeRedis` sharing one client per URI, `defineCache` / `bindCache` whose key
  is built by a typed function and whose value is checked by its schema both
  ways, `withLock` over `SET NX PX` released by a compare-and-delete script, and
  `defineChannel` / `publish` / `subscribe` typed the same way. Its one error is
  `RedisError`.

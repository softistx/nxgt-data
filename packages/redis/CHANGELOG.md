# @nxgt/redis

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

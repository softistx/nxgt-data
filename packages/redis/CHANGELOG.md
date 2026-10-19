# @nxgt/redis

## 0.9.0

### Minor Changes

- [#214](https://github.com/softistx/nxgt-data/pull/214) [`71e82fd`](https://github.com/softistx/nxgt-data/commit/71e82fd0702a89cf6af76cc9aeec92d4c3996781) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A queue: `defineQueue` and `bindQueue` — jobs typed by a schema, delays, priorities, at-least-once workers with leases, retries with backoff, retention and inspection.

- [#220](https://github.com/softistx/nxgt-data/pull/220) [`1432ac3`](https://github.com/softistx/nxgt-data/commit/1432ac39c0817d3d836a2949120a14a55072beeb) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Queue flow control. `pause()` and `resume()` stop and restart every worker of a queue, running jobs finishing as they go, and `counts()` gains `paused`. A queue's `rateLimit: { limit, per, burst? }` caps how many jobs start per span across every worker of every process, counted by the same GCRA as `defineRateLimit`. `add` and `addMany` take `debounce: { key, wait }` (jobs added under one key collapse into one that runs `wait` after the last, replacing the data of a job that has not started) or `throttle: { key, window }` (the first add under a key wins for `window`, later ones answer its id with `deduplicated: true`). Each is refused with a `TypeError` when combined with `id`, with each other, or (for `debounce`) with `delay` or `at`. New types: `QueueRateLimit`, `QueueRate`, `DebounceOptions` and `ThrottleOptions`.

- [#222](https://github.com/softistx/nxgt-data/pull/222) [`3569833`](https://github.com/softistx/nxgt-data/commit/35698336cd99643f92e937ee31188d1617aa83ec) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A queue's jobs can be grouped. `defineQueue({ groups: {} })` gives each group fair turns, and `groups: { concurrency: n }` also caps the jobs of one group that run at once, across every worker. `add(data, { group })` and `addMany` items take the group name (no `:` or braces); jobs without one form a default group with no cap, and `get` shows `group` for a named one, and the resolved `QueueGroups` type is exported beside `QueueGroupsInput`. A claim serves the groups in round-robin, the most urgent job first within a group, so one tenant cannot hold up the others, and workers do not spin while every ready job sits in a full group. `group` on a queue defined without `groups` is a `TypeError`.
  
  Every queue now writes a marker, `queue:{<name>}:groups:mode`. A process whose definition disagrees with it on `groups` or on `concurrency` gets a `QueueError` with the new code `GROUPS_MISMATCH` and writes nothing. To change modes, drain the queue and `DEL` the marker.

- [#215](https://github.com/softistx/nxgt-data/pull/215) [`817fbad`](https://github.com/softistx/nxgt-data/commit/817fbad6504702bca8af2193f6535a3716cc7594) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Queue jobs return a typed result; `add` gives a handle with `finished()` and `cancel()`; a job has a `timeout`, an `AbortSignal` and `progress()`; workers emit typed events and have `idle()` and `close({ grace })`.

- [#224](https://github.com/softistx/nxgt-data/pull/224) [`7cc1634`](https://github.com/softistx/nxgt-data/commit/7cc16346405f30c5153c12e69b11743c5903db97) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A worker that closes gives back the jobs a claim still in flight took for it: they are `waiting` again at once, with their attempt and group slot returned, instead of waiting out a lease.

- [#219](https://github.com/softistx/nxgt-data/pull/219) [`4b59a39`](https://github.com/softistx/nxgt-data/commit/4b59a390a2d79749f1da14f55c05a69bd9f9d928) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `retry(id, { fresh: true })` clears a failed job's stored step values, so every `job.step` runs again; `retry(id)` still resumes after the last finished step. `job.key(name)` is the same either way. A `fresh` that is not `true` or `false` is a `TypeError`. New type: `RetryOptions`.

- [#221](https://github.com/softistx/nxgt-data/pull/221) [`2f89016`](https://github.com/softistx/nxgt-data/commit/2f8901683a2f5fef45abff673f48e5abca9ba4da) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Queues run recurring jobs. A schedule is a five-field cron with an optional IANA time zone, or an `every` interval, and it is declared in `defineQueue({ schedules })` or managed at run time with `queue.schedules.upsert`, `remove` and `list`. A worker fires each schedule that is due as the job `schedule:<id>:<ms>`, exactly once across processes, and an outage fires the missed occurrence once rather than once per missed tick. Static schedules are synced once per client per process, when the first worker of a queue starts: one that leaves the definition is removed, and runtime schedules are never touched. Schedules fire while a queue is paused, and nothing fires while no worker runs.
  
  A job id given to `add` cannot start with `schedule:`, which names scheduled occurrences.

- [#216](https://github.com/softistx/nxgt-data/pull/216) [`8fc58bb`](https://github.com/softistx/nxgt-data/commit/8fc58bb272eba9b39a28e6edc77c1a993c8e3bfd) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Queue handlers get durable steps: `job.step(name, fn)` commits a side effect's value once per job, fenced against a stale worker, so a retry gets the stored value back instead of running `fn` again. `fn` may still run more than once (a crash, or a lease lapsing mid-step), so `job.key(name)` gives a stable idempotency key to hand downstream.
  
  A queue name cannot hold `:`, so `job.key` is unambiguous: `defineQueue` throws a `TypeError` for one.
  
  `StepOptions` is exported. `finished({ timeout })` is a hard bound: it rejects `WAIT_TIMEOUT` on time even when a connection hangs.

- [#218](https://github.com/softistx/nxgt-data/pull/218) [`6dc386a`](https://github.com/softistx/nxgt-data/commit/6dc386a7f7de81dad51f84f53ace345fc7ddb906) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Queues are wired like caches and guards: `defineRedis({ queues })` (and `openRedis`) gives `redis.queues.<key>` under the deployment's prefix, and `redis.close({ grace })` closes their workers first. Once the Redis is closed, a queue refuses `add`, `addMany`, `work` and `finished` (pending ones too) with `QueueError` `CLOSED`; admin calls (`get`, `list`, `counts`, `retry`, `remove`, `cancel`) still pass through. Two things are refused when queues are wired: a prefix with braces, and a queue name shared with a cache, a rate limit or an idempotency. `job.key` carries the prefix: `<prefix>:<queue>:<id>:<step>`.

## 0.8.0

### Minor Changes

- [#201](https://github.com/softistx/nxgt-data/pull/201) [`7446b9f`](https://github.com/softistx/nxgt-data/commit/7446b9fbed5d21d35f98e5c7d4fec0606ac78902) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/redis/testing` and a per-call deadline for the guards.
  
  - `@nxgt/redis/testing` exports `startTestRedis(options?)`, which starts a real Redis for a suite on a free port and resolves to `{ uri, reset, stop }` (`reset` is `FLUSHALL`; a second `stop` does nothing), `buildTestRedis(options?)`, which builds it ahead of the suite and resolves to the `redis-server` path, and `TEST_REDIS_VERSION` (7.4.1). `$REDIS_BIN`, or `{ binary }`, names a `redis-server` to run instead, and nothing is built; `{ version, downloadDir }` choose the build. `redis-memory-server` (`>=0.17.1 <0.18`) is a new **optional** peer, used by this subpath alone: install it as a devDependency where a suite imports it. An application that never imports `/testing` installs nothing new.
  - `consume`, `enforce` and `peek` take a third argument, `{ timeoutMs }`, and `run` takes `timeoutMs` beside `fingerprint` and `wait`. When Redis has not answered within it, the call rejects with `GuardError` code `TIMEOUT` (new in `GuardErrorCode`), naming the definition, never the key. The command is not withdrawn: a timed-out `consume` or `enforce` may still count its cost, and a `run` whose store timed out may still store its result. A `run` whose key-taking timed out sends a release behind it, so a key the late script took is given back. A `timeoutMs` that is not a whole number of 1 or more rejects with a `TypeError` before anything is sent. New type: `LimitCallOptions`.

## 0.7.2

### Patch Changes

- [#199](https://github.com/softistx/nxgt-data/pull/199) [`8a288ae`](https://github.com/softistx/nxgt-data/commit/8a288ae71d014c5637cf2ddb8a83053a8a3b6292) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Accept TypeScript 7 as a peer: the `typescript` peer range is now `^6.0.3 || ^7.0.0`.

## 0.7.1

### Patch Changes

- [#197](https://github.com/softistx/nxgt-data/pull/197) [`0895cc1`](https://github.com/softistx/nxgt-data/commit/0895cc1735181ba6ee624534b052f794d801433a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The declaration files now import each other with a `.js` extension, so a project with `moduleResolution: "nodenext"` (or `node16`) sees every export. Before, a name re-exported through a relative module was missing there (TS2305), as `@nxgt/mongo`'s were.

## 0.7.0

### Minor Changes

- [#186](https://github.com/softistx/nxgt-data/pull/186) [`142488c`](https://github.com/softistx/nxgt-data/commit/142488cc7c5b833ca138bfe9ad6b9d99bf4f08d8) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Bound caches, rate limits and idempotency expose their `definition`, read-only: `redis.limits.api.definition.limit`, `.per`, `.ttl`, `.lease`. A consumer handed a bound guard no longer needs the definition passed a second time. Bound by hand it is the given definition; wired through `openRedis` it is a frozen copy with the prefix in its name, so `definition.name` is the name actually written. A wired channel carries it too. Additive: the bound types stay as loose in their parameter as before, so `BoundRateLimit<{ ip: string }>` still assigns to `BoundRateLimit<unknown>`.

## 0.6.0

### Minor Changes

- [#184](https://github.com/softistx/nxgt-data/pull/184) [`6dc92d3`](https://github.com/softistx/nxgt-data/commit/6dc92d3f9c3ff385f91a0cc1c1337d25a2ac63b4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Rate limits and idempotency are wired by `defineRedis` and `openRedis`, the way caches and channels are. Hand `defineRedis` the modules that export them — `limits: { login }` from `defineRateLimit`, `idempotency: { orders }` from `defineIdempotency`, as `import * as` gives them — and `openRedis` binds each to its instance's client under that instance's `prefix`, typed from the configuration: `redis.limits.login.enforce({ ip })`, `redis.idempotency.orders.run({ user, key }, () => placeOrder())`, or `redis.instances.<name>.limits…` with several instances (`redis.limits` is `never` then, as `redis.cache` is). Each slot keeps only its own kind, as `caches` and `channels` do, so one module that exports several kinds can be passed as every slot. One definition under two keys is refused as a cache is, and so is one name shared by a cache, a rate limit and an idempotency on one instance (they all write `<name>:<key>`; channels are exempt) — at run time, comparing names. An instance that wires nothing now says `wires no cache, no channel, no rate limit and no idempotency` — the message changed, its meaning did not. A `defineIdempotency` definition under `caches` was wired as a cache at run time and is now skipped, so the run time matches the types. `InstanceConfig` takes two more type parameters, `Li` and `Id`, which default to `object`, so a written `InstanceConfig<A, B>` still compiles.
  
  A guard bound through the wiring writes `<prefix>:<name>:<key>`; one bound by hand with `bindRateLimit` or `bindIdempotency` writes no prefix, and still does. **An application that moves from by hand to wired, with a `prefix`, starts on new keys:** every rate-limit bucket starts full again and an idempotency record the old code wrote is not replayed. New exports: `LimitsOf`, `IdempotencyOf`, `LimitsIn`, `IdempotencyIn`, `LimitScope`, `IdempotencyScope`, `SoleLimits` and `SoleIdempotency`.

## 0.5.0

### Minor Changes

- [#181](https://github.com/softistx/nxgt-data/pull/181) [`050352e`](https://github.com/softistx/nxgt-data/commit/050352ef73db1f43f7ea3267ec730ba2bf340af3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The rate limits and the idempotency of `@nxgt/redis-guard` are now in this package, exported from the root and **not renamed**. New exports: `defineRateLimit`, `bindRateLimit`, `defineIdempotency`, `bindIdempotency`, and the error `GuardError` with its codes `GuardErrorCode` (`RATE_LIMITED`, `COST`, `IN_PROGRESS`, `MISMATCH`, `INVALID`, `LEASE_LOST`). The types come with them: `RateLimitDefinition`, `BoundRateLimit`, `LimitResult`, `IdempotencyDefinition`, `BoundIdempotency`, `Idempotent` and `RunOptions`. Each takes any Bun `RedisClient` — the `client` of a connection or of `openRedis`, or your own — and every message is what `@nxgt/redis-guard` 0.3.2 gave. `GuardError` stays its own class, apart from `RedisError`. Nothing existing changes. The guides, the troubleshooting entries and the roadmap moved here with it, and the README has a section on each. A cache definition and an idempotency definition are no longer assignable to each other — `bindCache(client, someIdempotency)` and `bindIdempotency(client, someCache)` were compile errors waiting to be `WRONGTYPE` at run time: `CacheDefinition` declares `lease?: never`, and `IdempotencyDefinition` has a required `lease`, which `defineIdempotency` fills with 10 000 when it is left out. A definition built by hand, not through `defineIdempotency`, must now carry its `lease`.

## 0.4.1

### Patch Changes

- [#179](https://github.com/softistx/nxgt-data/pull/179) [`72b07dd`](https://github.com/softistx/nxgt-data/commit/72b07dd34af44d41a923baac3d039775cd51b552) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The wiring guide compares with `@nxgt/mongo`'s `openMongo`, not the folded `@nxgt/mongo-kit`.

## 0.4.0

### Minor Changes

- [#172](https://github.com/softistx/nxgt-data/pull/172) [`afec9ae`](https://github.com/softistx/nxgt-data/commit/afec9ae19ab4d0fbb9af66134895c23f87425433) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The Redis wiring of `@nxgt/redis-kit` is now in this package. New exports: `defineRedis`, which checks a configuration of one or several Redis instances and freezes it without connecting to anything, and `openRedis`, which opens the clients and gives back a `Redis` whose `cache` and `channels` scopes carry every definition typed under the key it is exported as — `redis.cache.users.remember(…)`, `redis.channels.created.publish(…)` — with the deployment's `prefix` in front of every key, channel and lock, plus `lock`, `ping`, `clients` and a `close()` that closes the subscriptions nobody closed before the clients it opened. The types come with them: `Redis`, `RedisOf`, `RedisConfig`, `RedisConfigInput`, `RedisLockOptions`, `InstanceConfig`, `InstanceName`, `InstancesOf`, `CachesIn`, `CachesOf`, `ChannelsIn`, `ChannelsOf`, `BoundChannel`, `CacheScope`, `ChannelScope`, `InstanceScope`, `PayloadOf`, `SoleCache`, `SoleChannels` and `SoleInstance`.
  
  It is what `@nxgt/redis-kit` shipped, renamed: `connectKit` is `openRedis`, `defineConfig` is `defineRedis`, `RedisKit` is `Redis`, `KitOf` is `RedisOf`, `KitConfig` and `KitConfigInput` are `RedisConfig` and `RedisConfigInput`, `KitLockOptions` is `RedisLockOptions`. The messages follow: they begin `defineRedis:` and `openRedis:`, and the two that named a call read `cache: this Redis holds 2 Redis instances, …` and `lock: this Redis has no instance named "…"`. Nothing existing changes.

## 0.3.2

### Patch Changes

- [#143](https://github.com/softistx/nxgt-data/pull/143) [`85573aa`](https://github.com/softistx/nxgt-data/commit/85573aa3af6ac1863bd87a68f0fc5fda90c000bb) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Build and type-check under a stricter `tsconfig` — `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals` and the rest — so the published declarations compile under any of them in an application. One thing the built JavaScript does differently: class fields are defined as JavaScript defines them (`useDefineForClassFields`), so an error's fields are its own properties from construction, listed in the order they are declared. Their values are unchanged, and `GuardError.retryAfter` is still absent when it was not given.

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

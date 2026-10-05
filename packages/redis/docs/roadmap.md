# Roadmap

Where `@nxgt/redis` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

- **The refusal of an unknown option, in the message it was written for** —
  an option the configuration does not have is a compile error today, but
  TypeScript usually reports it as `is not assignable to type 'never'` on
  every property of the object, and only sometimes as the sentence the
  constraint carries, `"nope" is not an option here`. The intended message
  should be the one every case shows.

## Later

- **A `./hono` subpath** — a middleware that answers a spent limit with a 429
  and the `RateLimit-*` headers. Only once a consumer is found copying the
  [HTTP recipe](guide/guard/rate-limits.md#http-headers-for-any-framework):
  until then the recipe is a dozen lines for any framework, and a subpath would
  be one more peer to keep in step.

## Not planned

- **Running on Node** — the client is Bun's own `RedisClient`, which is why
  this package installs no driver at all. There is nothing to swap for Node,
  and a build for it is not coming: it needs Bun 1.4 or later, for
  `duplicate()`, `subscribe`/`unsubscribe` and the variadic `set`.
- **`multi` / `exec`** — Bun's client has neither, and nothing here needs
  them: the lock is `SET NX PX`, one command, and its release is one
  compare-and-delete script.
- **Retries of its own** — Bun's client reconnects; a command that fails
  fails, and what comes back is Redis's own error, as `RedisError`.
- **A queue** — pub/sub is fire-and-forget. A message published while nobody
  is subscribed is gone, and nothing is stored, acknowledged or replayed.
- **An actor, or a session** — `@nxgt/mongo`'s `openMongo` derives its object with
  `as(actor)` and `withSession`, because MongoDB has something to stamp and
  something to carry. Redis has neither, so what `openRedis` gives back is the
  same object for every request, is never derived, and `close()` always
  belongs to the one you hold.
- **Invalidating a cache by pattern** — `redis.cache.users.delete(pattern)`
  needs `SCAN` over the keyspace to find what to delete: O(N) in the number of
  keys, on a server that runs one command at a time, and racy — a key written
  while the scan is running is missed. Delete the keys you know
  (`delete(params)`), or let the `ttl` do it.
- **One augmented client instead of two scopes** — `redis.cache.<key>` and
  `redis.channels.<key>` are two scopes rather than a client with names on it.
  A Redis client answers to a hundred commands, so a cache and a channel of the
  same name would fight over it, and nothing here needs to fall through to a
  driver member: `redis.instances.<name>.client` is the driver, untouched.
- **Closing a client the configuration handed over** — `openRedis` gives back
  only what it opened, `await using` included. What it did not open is not its
  to close.
- **An error class for the wiring** — every refusal `defineRedis` and
  `openRedis` make is wiring-time, and there are few enough to tell apart by
  their sentence, each naming the instance and the call. A `RedisError` still
  reaches a caller from a cache, a channel or a lock, with its `code`.
- **Closing on a signal** — nothing listens to `SIGTERM` for you. Call
  `close()` on a connection, or `closeRedis()`, where your process shuts down.
- **The host's clock for a rate limit** — `now` is the Redis server's `TIME`,
  read inside the script, so every process agrees and a host with a wrong clock
  cannot refill a bucket. An option to send the caller's time instead would
  give that up.
- **Fixed or sliding windows** — GCRA gives the same guarantees in one string
  per key, with no counter per window and no sorted set per caller.
- **An in-memory fallback** — a limit that silently becomes per-process when
  Redis is down is not the limit you defined. A failed call fails, with
  Redis's own error. The same holds for idempotency.
- **Storing thrown errors** — an error from `work` gives the key back, so the
  next call runs again. A failure that must replay is a result: a union member
  of the schema, which the types check and a replay parses like any other.
- **Interrupting `work` when its lease is lost** — an `AbortSignal` handed to
  `work`, say. `work` is your function, and `run` only ever calls it and
  awaits it: JavaScript has no way to stop it, so a signal would be a request
  that `work` may ignore, and it could not undo what `work` had already done.
  It would not fire in the case that matters most either: a lease is lost
  when synchronous work holds the event loop for a whole lease, and the
  renewal that would notice is a timer on that same blocked loop. So a lost
  lease is reported where it can be acted on — `run` refuses to store the
  result and rejects with `LEASE_LOST` once `work` returns — and a caller that
  wants to stop early can keep its own `AbortController` and deadline inside
  `work`.
- **Treating an unreadable stored result as a miss** — as a cache would. A
  stored result stands for work that already happened; running it again
  would do it twice. It is `INVALID`, and `forget` is the deliberate way to
  run again.

## Shipped

- **Bound caches, rate limits and idempotency expose their definition** —
  `definition` on each, read-only: `redis.limits.api.definition.limit`, `.per`,
  `.ttl`, `.lease`, so a consumer handed a bound guard need not be handed its
  policy too. Wired, it is the frozen copy with the prefix, so
  `definition.name` is the name actually written. The wired channel has it too.

- **Rate limits and idempotency wired by `defineRedis` and `openRedis`** —
  definitions exported from a module and handed to `defineRedis` as `limits`
  and `idempotency`, bound by `openRedis` under the instance's `prefix` and
  typed from the configuration: `redis.limits.login.enforce(…)`,
  `redis.idempotency.orders.run(…)`, as the caches are. Each slot keeps only its own
  kind, and a name shared by a cache, a rate limit and an idempotency on one
  instance is refused. A guard
  still bound by hand writes no prefix, so moving one to the wiring starts new
  keys — counts restart and stored results are not replayed. New exports:
  `LimitsOf`, `IdempotencyOf`, `LimitsIn`, `IdempotencyIn`, `LimitScope`,
  `IdempotencyScope`, `SoleLimits` and `SoleIdempotency` — 0.6.0.
- **Rate limits and idempotency, folded in from `@nxgt/redis-guard`** —
  `defineRateLimit` / `bindRateLimit`: GCRA as one atomic script over one key,
  timed by the Redis server's clock, with `consume`, `enforce`, `peek` and
  `reset`, a `cost` per call, and results as delays in milliseconds, counted in
  exact integers. `defineIdempotency` / `bindIdempotency`, with `run` and
  `forget`: the first call with a key runs `work` and keeps its result, checked
  by a zod schema, and a repeat gets it back; a different fingerprint is
  refused (`MISMATCH`), a repeat during the first run is refused
  (`IN_PROGRESS`, with `retryAfter`) or waits with `wait`, and the running call
  renews its lease while `work` runs, so `lease` only bounds how long a
  **crashed** run holds the key. Their error is `GuardError`, with its own
  codes. Nothing was renamed: `@nxgt/redis-guard` now re-exports this one,
  deprecated — 0.5.0.
- **The wiring, folded in from `@nxgt/redis-kit`** — `defineRedis` checking a
  configuration of one or several Redis instances and freezing it without
  connecting to anything, and `openRedis` opening the clients and giving back
  a `Redis` whose `cache` and `channels` scopes carry every definition typed
  under the key it is exported as, with the deployment's `prefix` in front of
  every key, channel and lock; `lock`, `ping`, `clients`, and a `close()` that
  closes the subscriptions nobody closed before the clients it opened.
  `RedisOf<typeof config>` writes the type from the configuration. It is what
  `@nxgt/redis-kit` shipped, renamed: `connectKit` is `openRedis`,
  `defineConfig` is `defineRedis` and `RedisKit` is `Redis`; that package now
  re-exports this one, deprecated — 0.4.0.
- **A cache value written as the schema *accepts* it** — `set` and a
  `remember` loader take `z.input` of the schema, so a field with a
  `.default()` may be left out where a value is written, and every reader gets
  it filled; reads still give `z.output`, and `InputOf<D>` names the written
  shape — 0.3.0.
- **The connection failures are a `RedisError` too** — `CONNECTION` for a
  connect a close interrupted, `PING_TIMEOUT` on the result `ping` reports,
  so one class and one code cover everything this package refuses; neither
  prints the URI, and a connection string holds the password — 0.2.0.
- **Documentation that travels with the package** — a guide page for
  connections, caches, locks and channels, a troubleshooting page whose
  headings are the exact error text, and this roadmap, installed in `docs/`
  rather than left on GitHub — 0.1.1.
- **`ValueOf<D>` resolves again** — it matched `CacheDefinition<unknown, …>`,
  which a definition whose `key` takes anything narrower is not assignable to,
  so it gave `never` for every real cache. `ParamsOf` was never affected —
  0.1.1.
- **First release** — `connectRedis` / `closeRedis` sharing one client per
  URI, `defineCache` / `bindCache` whose key is built by a typed function and
  whose value is checked by its schema both ways, `withLock` over `SET NX PX`
  released by a compare-and-delete script, and `defineChannel` / `publish` /
  `subscribe` typed the same way; its one error is `RedisError` — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/redis/CHANGELOG.md) — it is not in
the published package, only in the repository.

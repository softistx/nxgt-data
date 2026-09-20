# Roadmap

Where `@nxgt/redis` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

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
- **Closing on a signal** — nothing listens to `SIGTERM` for you. Call
  `close()` on a connection, or `closeRedis()`, where your process shuts down.

## Shipped

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

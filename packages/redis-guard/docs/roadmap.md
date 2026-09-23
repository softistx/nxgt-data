# Roadmap

Where `@nxgt/redis-guard` is going. A direction, not a commitment: the version
an item shipped in is the only number on this page.

## Now

_Nothing: the lease heartbeat and `wait` shipped._

## Next

_Nothing planned yet: see Later._

## Later

- **A `./hono` subpath** — a middleware that answers a spent limit with a 429
  and the `RateLimit-*` headers. Only once a consumer is found copying the
  [HTTP recipe](guide/rate-limits.md#http-headers-for-any-framework): until
  then the recipe is a dozen lines for any framework, and a subpath would be
  one more peer to keep in step.
- **Wiring in `@nxgt/redis-kit`** — rate limits and idempotent operations
  bound under the kit's instances and prefixes, as its caches are.

## Not planned

- **Running on Node** — it takes Bun's own `RedisClient`, which is why it
  installs no driver at all.
- **The host's clock** — `now` is the Redis server's `TIME`, read inside the
  script, so every process agrees and a host with a wrong clock cannot refill
  a bucket. An option to send the caller's time instead would give that up.
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

- **Rate limits** — `defineRateLimit` / `bindRateLimit`: GCRA as one atomic
  script over one key, timed by the Redis server's clock, with `consume`,
  `enforce`, `peek` and `reset`, a `cost` per call, and results as delays in
  milliseconds, counted in exact integers. Its error is `GuardError`, with
  `RATE_LIMITED` and `COST` — 0.1.0.
- **Idempotency** — `defineIdempotency` / `bindIdempotency`, with `run` and
  `forget`: the first call with a key runs `work` and keeps its result, checked
  by a zod schema; a repeat gets that result back without running it again. A
  different fingerprint is refused (`MISMATCH`), a repeat during the first run
  is refused (`IN_PROGRESS`, with `retryAfter`), and an error thrown by `work`
  is never stored. The running call holds a lease, so a process that dies
  mid-work frees the key when the lease runs out rather than never. `zod`
  became a required peer — 0.2.0.
- **A heartbeat for the lease** — while `work` runs, `run` renews its lease
  every third of it, comparing its own token, so work of any length runs
  once and `lease` only bounds how long a **crashed** run holds the key.
  `LEASE_LOST` now means the key was taken from the run — `forget`, or no
  renewal reached Redis for a whole lease — 0.3.0.
- **`wait`** — an option for `run` to wait for a running key, up to a
  deadline in milliseconds, instead of rejecting at once with `IN_PROGRESS`:
  a repeat gets the replay, or runs `work` itself if the first run gave the
  key back — 0.3.0.

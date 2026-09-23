# Roadmap

Where `@nxgt/redis-guard` is going. A direction, not a commitment: the version
an item shipped in is the only number on this page.

## Now

_Nothing: rate limits shipped, idempotency is next._

## Next

- **Idempotency** — `run(key, work)`: the first call with a key runs `work`
  and keeps its result; a repeat with the same key gets that result back
  instead of running it again. The request is fingerprinted, so the same key
  sent with a different body is refused (`MISMATCH`) rather than answered with
  somebody else's result, and a repeat that arrives while the first is still
  running is refused (`IN_PROGRESS`) rather than run beside it. The running
  call holds a lease, so a process that dies mid-work frees the key when the
  lease runs out rather than never.

## Later

- **A `./hono` subpath** — a middleware that answers a spent limit with a 429
  and the `RateLimit-*` headers. Only once a consumer is found copying the
  [HTTP recipe](guide/rate-limits.md#http-headers-for-any-framework): until
  then the recipe is a dozen lines for any framework, and a subpath would be
  one more peer to keep in step.
- **Wiring in `@nxgt/redis-kit`** — rate limits bound under the kit's
  instances and prefixes, as its caches are.

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
  Redis's own error.

## Shipped

- **Rate limits** — `defineRateLimit` / `bindRateLimit`: GCRA as one atomic
  script over one key, timed by the Redis server's clock, with `consume`,
  `enforce`, `peek` and `reset`, a `cost` per call, and results as delays in
  milliseconds, counted in exact integers. Its error is `GuardError`, with
  `RATE_LIMITED` and `COST` — 0.1.0.

# @nxgt/redis-guard

Guards on **Bun's own Redis client**: rate limits described once, keyed by a
typed function, and checked by one atomic script on the server — timed by the
**Redis server's clock**, so every process sharing the Redis shares the limit
exactly.

```ts
import { RedisClient } from 'bun';
import { bindRateLimit, defineRateLimit } from '@nxgt/redis-guard';

const loginLimit = defineRateLimit({
	name: 'login',
	key: (p: { ip: string }) => p.ip,
	limit: 5,
	per: 60_000,                                // milliseconds — see Traps
});

const redis = new RedisClient(process.env.REDIS_URL);
const login = bindRateLimit(redis, loginLimit);

async function handleLogin(ip: string): Promise<Response> {
	const result = await login.consume({ ip });
	if (!result.allowed) {
		return new Response('Too many attempts', {
			status: 429,
			headers: { 'Retry-After': String(Math.ceil(result.retryAfter / 1000)) },
		});
	}
	return new Response('Welcome');
}
```

> **0.x.** Rate limits are the first guard; idempotency is next — see the
> [roadmap](docs/roadmap.md).

## Install

```sh
bun add @nxgt/redis-guard
bun add -d @types/bun typescript
```

- **Bun 1.4 or later, and Bun only.** It takes Bun's `RedisClient`, which is
  built into Bun — so there is no driver to install, and it does not run on
  Node.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package
  pins.
- `@types/bun`: required to typecheck. The shipped declarations name Bun's
  `RedisClient`, so without Bun's types the first `tsc` fails with
  `Cannot find module 'bun'`.
- It depends on no other `@nxgt` package. Any `RedisClient` will do — your
  own, or the `client` of an `@nxgt/redis` connection.
- Tested against Redis 7.4. It needs `EVALSHA`, `EVAL` and `TIME` in a
  script, which every Redis since 5 allows.

## Rate limits

```ts
import { RedisClient } from 'bun';
import { bindRateLimit, defineRateLimit, GuardError } from '@nxgt/redis-guard';

const redis = new RedisClient(process.env.REDIS_URL);

export const exportLimit = defineRateLimit({
	name: 'export',
	key: (p: { org: string; user: string }) => `${p.org}/${p.user}`,
	limit: 10,          // ten requests…
	per: 60_000,        // …a minute, in milliseconds
	burst: 20,          // and up to twenty at once from a full bucket
});

const exports = bindRateLimit(redis, exportLimit);
const who = { org: 'acme', user: 'u1' };

// Counts the call if it is allowed, and says how much is left.
const result = await exports.consume(who);
// { allowed: true, limit: 20, remaining: 19, resetAfter: 6000, retryAfter: 0 }

// A big export counts for more than one request.
await exports.consume(who, 5);

// Throws instead of returning a denial.
async function startExport(): Promise<Response> {
	try {
		await exports.enforce(who);
	} catch (error) {
		if (error instanceof GuardError && error.code === 'RATE_LIMITED') {
			const seconds = Math.ceil((error.retryAfter ?? 0) / 1000);
			return new Response('Too many exports', {
				status: 429,
				headers: { 'Retry-After': String(seconds) },
			});
		}
		throw error;
	}
	return new Response('Export started', { status: 202 });
}

// What consume would answer, counting nothing — for a form that shows
// "3 attempts left" before anyone submits it.
const left = await exports.peek(who, 0);

// A support action: the next request starts from a full bucket.
await exports.reset(who);
```

The algorithm is **GCRA** (the generic cell rate algorithm): one Redis string
per key holds the time the bucket will be full again, and one Lua script reads
it, decides and writes, in a single step. A denial writes nothing, a `peek`
writes nothing, and the key expires when the bucket is full again, so an idle
limit leaves nothing in Redis.

The [rate limits guide](docs/guide/rate-limits.md) has the algorithm in
detail, choosing `limit`, `per` and `burst`, and an HTTP recipe with the
`RateLimit-*` and `Retry-After` headers for any framework.

## API

| Function | |
| --- | --- |
| `defineRateLimit({ name, key, limit, per, burst? })` | describes a rate limit; talks to nothing. Frozen. A definition that could never work is a bare `TypeError`, normally at import |
| `bindRateLimit(client, definition)` | binds it to a `RedisClient`. Checks the definition again, for one written by hand |

| `RateLimitDefinition<P>` | |
| --- | --- |
| `name` | the key's prefix. A stored key is `` `<name>:<key(params)>` `` |
| `key(params)` | the rest of the key, from whatever is limited |
| `limit` | how many requests `per` allows, once refilled. A whole number, at least 1 |
| `per` | the window, **in milliseconds**. A whole number, at least 1 |
| `burst` | how many may arrive at once from a full bucket. Defaults to `limit` |

| `BoundRateLimit<P>` | |
| --- | --- |
| `keyFor(params)` | the key it would use, for a caller that needs the string |
| `consume(params, cost = 1)` | counts the call if it is allowed. A denial counts nothing |
| `enforce(params, cost = 1)` | `consume`, throwing `RATE_LIMITED` on a denial |
| `peek(params, cost = 1)` | what `consume` would answer, writing nothing. `cost` may be `0`, to read the bucket as it is |
| `reset(params)` | refills the bucket. `true` when something was counted |

`cost` is a whole number from 1 to the burst — from 0 for `peek` — or the call
rejects with `COST`.

| `LimitResult` | |
| --- | --- |
| `allowed` | whether this call was allowed — and, for `consume`, counted |
| `limit` | the burst: how many requests a full bucket holds |
| `remaining` | how many requests of cost 1 would be allowed now, after this one |
| `resetAfter` | milliseconds until the bucket is full again; `0` when it is |
| `retryAfter` | milliseconds until this call would be allowed; `0` when it was |

Every duration is a **delay in milliseconds**, measured on the Redis server's
clock and rounded up — never a `Date`, which would carry the difference
between two clocks. Waiting `retryAfter` is always enough.

| Type | |
| --- | --- |
| `RateLimitDefinition<P>` | what `defineRateLimit` takes and gives back |
| `BoundRateLimit<P>` | what `bindRateLimit` gives back |
| `LimitResult` | what every check answers |
| `GuardError`, `GuardErrorCode` | the error, and its codes |

## Errors

`GuardError` is what this package throws, with a `code` and the `definition`
it happened on — its `name`, never the key it built nor the params, which
came from a request.

| `GuardErrorCode` | | |
| --- | --- | --- |
| `RATE_LIMITED` | `enforce` found the limit spent. Carries `retryAfter`, in milliseconds | `enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again` |
| `COST` | a cost that is not a whole number from 1 (0 for `peek`) to the burst | `consume on "login": a cost must be a whole number from 1 to the burst of 5` |

**`TypeError`s come earlier, at definition time**, and normally at import:
`defineRateLimit` (and `bindRateLimit`, for a definition written by hand)
refuses an empty `name`, a `key` that is not a function, a `limit`, `per` or
`burst` that is not a whole number of at least 1, a rate faster than 500
requests a millisecond, and a rate that would take more than ten years to
refill from empty. Redis's own failures come back as
they are, from Bun's client. Every message is in
[troubleshooting](docs/troubleshooting.md).

## What does not compile

Each is a `@ts-expect-error` case in `test/types/guard.ts`.

- A call with the wrong params, or with some of them missing.
- A `cost` that is a string — `consume(params, '2')`.
- A definition without `per`, `limit` or `key`, a `per` or a `burst` given as
  a string, a `key` that gives anything but a string, and an option it does
  not have — `window` for `per`.
- `reset` with a cost, a `LimitResult` written to, a definition changed after
  it is defined, and `bindRateLimit` without a client.
- A `GuardErrorCode` it does not have, and `retryAfter` read as if it were
  always there.

## Traps

- **GCRA is a rate, not a counter of windows.** A full bucket takes `burst`
  requests at once and then refills at `limit` per `per` — one every
  `per ÷ limit` ms. So in the first `per` after an idle spell a caller can
  make up to **`burst + limit − 1`** requests: 5 at once, then one every 12 s,
  is 9 within the first minute for `limit: 5, per: 60_000`. After that it
  holds to the rate. Set `burst` lower where the first minute matters.
- **`per` is milliseconds.** `per: 60` is 60 **ms**, not a minute — a limit
  that refills almost at once and so limits nothing. Nothing can refuse it:
  60 ms is a legitimate window. A rate that would take more than ten years to
  refill is refused, which catches a `per` written in microseconds, but not
  one written in seconds.
- **No faster than 500 a millisecond.** The script counts in microseconds and
  needs at least 2 between requests, so `per × 1000 ÷ limit` under 2 is
  refused at definition. `limit: 60_000, per: 1` — the two swapped — is the
  usual way to hit it.
- **Bun only.** It takes Bun's `RedisClient`, and runs on Node never.
- **The clock is the Redis server's.** `now` is read with `TIME` inside the
  script, so a host with a wrong clock cannot refill a bucket or empty one,
  and every process agrees. Two consequences: a result is a delay, which means
  the same on every host, and **changing the server's own clock** moves every
  bucket — back a day, and every limited caller waits a day longer.
- **Every process must use the same definition.** Two deploys with different
  `limit`, `per` or `burst` under the same `name` read the same key with
  different rates. Rename the limit when its rate changes a lot.
- **`remaining` counts requests of cost 1.** A bucket with 2 remaining denies
  a `consume(params, 3)` and counts nothing.
- **A cost above the burst is refused, not queued.** No bucket ever holds more
  than `burst`, so it could never be allowed.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/rate-limits.md](docs/guide/rate-limits.md) — GCRA, choosing a
  rate, and the HTTP recipe.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT

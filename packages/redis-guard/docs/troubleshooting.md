# Troubleshooting

This package throws one error of its own, `GuardError`, with a `code` of
`RATE_LIMITED` or `COST`, and the `definition` it happened on — the limit's
`name`, never the key it built nor the params, which came from a request.
`RATE_LIMITED` also carries `retryAfter`, in milliseconds. Everything else
comes from Bun's `RedisClient` as it is.

`defineRateLimit` and `bindRateLimit` check a definition before anything is
sent, and throw a plain `TypeError`: those are mistakes in the code, not
something a running application can handle. The headings below say
`defineRateLimit`; the same refusal from `bindRateLimit`, for a definition
written by hand, says `bindRateLimit` instead.

- **Install and import**
  - [`ReferenceError: Bun is not defined`](#referenceerror-bun-is-not-defined)
  - [`Cannot find module 'bun' or its corresponding type declarations.`](#cannot-find-module-bun-or-its-corresponding-type-declarations)
- **Configuration**
  - [`defineRateLimit: a rate limit needs a name, for its keys`](#defineratelimit-a-rate-limit-needs-a-name-for-its-keys)
  - [`defineRateLimit: "login" has no key function; it builds the rest of the key from the params`](#defineratelimit-login-has-no-key-function-it-builds-the-rest-of-the-key-from-the-params)
  - [`defineRateLimit: "login" has a limit of 0; it is a whole number of requests, and must be at least 1`](#defineratelimit-login-has-a-limit-of-0-it-is-a-whole-number-of-requests-and-must-be-at-least-1)
  - [`defineRateLimit: "login" has a per of 0.5; it is a whole number of milliseconds, and must be at least 1`](#defineratelimit-login-has-a-per-of-05-it-is-a-whole-number-of-milliseconds-and-must-be-at-least-1)
  - [`defineRateLimit: "login" has a burst of 0; it is a whole number of requests, and must be at least 1`](#defineratelimit-login-has-a-burst-of-0-it-is-a-whole-number-of-requests-and-must-be-at-least-1)
  - [`defineRateLimit: "archive" has a burst of 1000000 and a per of 31536000000ms; burst × per must be at most 9007199254740 for the script to count exactly`](#defineratelimit-archive-has-a-burst-of-1000000-and-a-per-of-31536000000ms-burst--per-must-be-at-most-9007199254740-for-the-script-to-count-exactly)
  - [`defineRateLimit: "login" would take longer than ten years to refill from empty (burst × per ÷ limit); check that per is in milliseconds`](#defineratelimit-login-would-take-longer-than-ten-years-to-refill-from-empty-burst--per--limit-check-that-per-is-in-milliseconds)
- **Runtime**
  - [`enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again`](#enforce-on-login-the-limit-of-5-per-60000ms-is-spent-retryafter-says-when-to-try-again)
  - [`consume on "login": a cost must be a whole number from 1 to the burst of 5`](#consume-on-login-a-cost-must-be-a-whole-number-from-1-to-the-burst-of-5)
  - [`peek on "login": a cost must be a whole number from 0 to the burst of 5`](#peek-on-login-a-cost-must-be-a-whole-number-from-0-to-the-burst-of-5)
  - [A limit allows more than `limit` requests in its first `per`](#a-limit-allows-more-than-limit-requests-in-its-first-per)
  - [A limit barely limits anything](#a-limit-barely-limits-anything)
  - [Every limited caller has to wait much longer than `per`](#every-limited-caller-has-to-wait-much-longer-than-per)

## Install and import

### `ReferenceError: Bun is not defined`

**When:** importing `@nxgt/redis-guard` under Node — at load, before any call.
Measured on Node 22.
**Why:** every import of `bun` in this package is a type, so nothing asks
Node for the `bun` module; the first thing to fail is the `Bun` global, which
the script runner uses at load to compute the script's SHA-1 with
`Bun.CryptoHasher`. The package takes Bun's own `RedisClient`, which is why
there is no driver to install and why it does not run on Node.
**Fix:** run it with Bun 1.4 or later.

```sh
bun run ./src/index.ts
```

### `Cannot find module 'bun' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/redis-guard`.
**Why:** the shipped declarations import `RedisClient` from `bun`, so your
project needs Bun's types. They are not a dependency of this package.
**Fix:**

```sh
bun add -d @types/bun
```

## Configuration

### `defineRateLimit: a rate limit needs a name, for its keys`

**When:** at import, on a definition whose `name` is `''`.
**Why:** a stored key is `<name>:<key(params)>`. Without a name, two limits
over the same params would count into one bucket.
**Fix:** name it after what it limits, and give each limit its own name.

```ts
defineRateLimit({ name: 'login', key: (p: { ip: string }) => p.ip, limit: 5, per: 60_000 });
```

### `defineRateLimit: "login" has no key function; it builds the rest of the key from the params`

**When:** at import, on a definition whose `key` is not a function — usually
a string written where a function was meant, past a cast.
**Why:** the key is built from the params of each call; a fixed string would
put every caller in one bucket.
**Fix:**

```ts
key: (p: { ip: string }) => p.ip,
```

### `defineRateLimit: "login" has a limit of 0; it is a whole number of requests, and must be at least 1`

**When:** at import, on a `limit` that is 0, negative, fractional, `NaN` or
infinite. The message quotes the value it was given.
**Why:** `limit` is how many requests `per` allows. A fraction of a request is
not a request; to allow one every two minutes, say so with `per`.
**Fix:**

```ts
// Not `limit: 0.5, per: 60_000`:
defineRateLimit({ name: 'digest', key, limit: 1, per: 120_000 });
```

### `defineRateLimit: "login" has a per of 0.5; it is a whole number of milliseconds, and must be at least 1`

**When:** at import, on a `per` that is not a whole number of at least 1.
**Why:** `per` is the window in milliseconds; the script counts in whole ones.
**Fix:** write it in milliseconds — `per: 60_000` for a minute,
`per: 3_600_000` for an hour.

### `defineRateLimit: "login" has a burst of 0; it is a whole number of requests, and must be at least 1`

**When:** at import, on a `burst` that is given and is not a whole number of
at least 1.
**Why:** a burst of 0 would allow nothing, ever.
**Fix:** leave it out for the default, which is `limit`, or give a whole
number.

### `defineRateLimit: "archive" has a burst of 1000000 and a per of 31536000000ms; burst × per must be at most 9007199254740 for the script to count exactly`

**When:** at import, when `burst × per` is above 9,007,199,254,740 — here a
burst of a million over a year. `burst` defaults to `limit`, so a very large
`limit` with no `burst` hits it too; the message quotes the burst it used.
**Why:** the script counts in exact integers, in units of 1/limit of a
microsecond: a full bucket is `burst × per × 1000` of them. A Lua number
holds whole numbers exactly only up to `Number.MAX_SAFE_INTEGER`, and past
that the count would drift. The rate itself is never the problem — any
number of requests per millisecond counts exactly.
**Fix:** a smaller burst, or a shorter `per` at the same rate:

```ts
// A thousand a day, any thousand at once — not a million a year:
defineRateLimit({ name: 'archive', key, limit: 1_000, per: 86_400_000 });
```

### `defineRateLimit: "login" would take longer than ten years to refill from empty (burst × per ÷ limit); check that per is in milliseconds`

**When:** at import, when `burst × per ÷ limit` — how long an empty bucket
takes to fill — is more than ten years of milliseconds.
**Why:** nobody means that; it is almost always `per` written in a smaller
unit than milliseconds. It is a plausibility check, not an exactness one:
the bound above is that.
**Fix:**

```ts
per: 60_000,   // a minute — not 60e9
```

## Runtime

### `enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again`

**When:** `enforce` was called on a spent limit. It is a `GuardError` with
code `RATE_LIMITED`.
**Why:** that is what `enforce` is for. Nothing was counted.
**Fix:** answer it — in HTTP, a 429 with `Retry-After` in whole seconds,
rounded up:

```ts
if (error instanceof GuardError && error.code === 'RATE_LIMITED') {
	return new Response('Too many requests', {
		status: 429,
		headers: { 'Retry-After': String(Math.ceil((error.retryAfter ?? 0) / 1000)) },
	});
}
```

Or use `consume`, which returns the denial instead of throwing it.

### `consume on "login": a cost must be a whole number from 1 to the burst of 5`

**When:** `consume` or `enforce` (the message names which) got a cost of 0, a
fraction, `NaN`, or more than the burst. It is a `GuardError` with code
`COST`, the promise rejects, and nothing is sent to Redis.
**Why:** a cost above the burst could never be allowed — no bucket holds
more — and a cost of 0 counts nothing, which is what `peek` is for. The
message quotes the bounds, never the cost, which may have come from a
request.
**Fix:** check the cost where it comes from, or clamp it and answer 400:

```ts
const cost = Math.ceil(rows / 100);
if (cost > (exportLimit.burst ?? exportLimit.limit)) {
	return new Response('Export fewer rows at once', { status: 400 });
}
await exports.consume({ org, user }, cost);
```

### `peek on "login": a cost must be a whole number from 0 to the burst of 5`

**When:** `peek` got a fraction, a negative number, `NaN`, or more than the
burst. It is a `GuardError` with code `COST`.
**Why:** as for `consume`, except that `peek` also takes 0, to read the
bucket as it is.
**Fix:** `peek(params, 0)` for the state, `peek(params, n)` for whether a
cost of `n` would be allowed.

### A limit allows more than `limit` requests in its first `per`

**When:** `limit: 5, per: 60_000`, and a caller makes 9 requests in the first
minute, all allowed.
**Why:** GCRA is a rate, not a counter of fixed windows. A full bucket holds
`burst` (default `limit`) and refills one request every `per ÷ limit`: 5 at
once, then one at 12, 24, 36 and 48 s. Up to `burst + limit − 1` fit in the
first `per`; after that it holds to the rate.
**Fix:** a lower `burst`, if the first `per` matters:

```ts
defineRateLimit({ name: 'login', key, limit: 5, per: 60_000, burst: 2 });
```

### A limit barely limits anything

**When:** a limit that should hold callers to a few requests a minute lets
nearly everything through.
**Why:** `per` is **milliseconds**. `per: 60` is 60 ms, a window short enough
that the bucket refills between requests. Nothing refuses it, because 60 ms is
a legitimate window.
**Fix:**

```ts
per: 60_000,   // a minute
```

### Every limited caller has to wait much longer than `per`

**When:** after the Redis server's clock was moved back — by hand, or by a
failover to a replica whose clock is behind.
**Why:** the clock is the server's `TIME`, deliberately: no host's clock can
refill or empty a bucket. Each bucket remembers the server's time at its
last write, and refills nothing while the clock is behind it. A bucket that
was spent stays spent until the clock passes that time again; one with room
left is written at its next allowed call, and counts from the new time.
**Fix:** keep the Redis servers' clocks synchronised (NTP). To release every
caller at once after a clock mistake, delete the limit's keys — they hold
nothing else:

```sh
redis-cli --scan --pattern 'login:*' | xargs -r redis-cli del
```

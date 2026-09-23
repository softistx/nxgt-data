# Troubleshooting

This package throws one error of its own, `GuardError`, with a `code` —
`RATE_LIMITED` or `COST` from a rate limit, `IN_PROGRESS`, `MISMATCH`,
`INVALID` or `LEASE_LOST` from an idempotent `run` — and the `definition` it
happened on: its `name`, never the key it built, the params, a fingerprint or
a result, which came from a request. `RATE_LIMITED` and `IN_PROGRESS` also
carry `retryAfter`, in milliseconds. Everything else comes from Bun's
`RedisClient` as it is, and an error thrown by your own `work` passes through
`run` untouched.

`defineRateLimit`, `bindRateLimit`, `defineIdempotency` and `bindIdempotency`
check a definition before anything is sent, and throw a plain `TypeError`:
those are mistakes in the code, not something a running application can
handle. The headings below say `defineRateLimit` and `defineIdempotency`; the
same refusal from a `bind*`, for a definition written by hand, names that
call instead.

- **Install and import**
  - [`ReferenceError: Bun is not defined`](#referenceerror-bun-is-not-defined)
  - [`Cannot find module 'bun' or its corresponding type declarations.`](#cannot-find-module-bun-or-its-corresponding-type-declarations)
  - [`Cannot find module 'zod' or its corresponding type declarations.`](#cannot-find-module-zod-or-its-corresponding-type-declarations)
- **Configuration**
  - [`defineRateLimit: a rate limit needs a name, for its keys`](#defineratelimit-a-rate-limit-needs-a-name-for-its-keys)
  - [`defineRateLimit: "login" has no key function; it builds the rest of the key from the params`](#defineratelimit-login-has-no-key-function-it-builds-the-rest-of-the-key-from-the-params)
  - [`defineRateLimit: "login" has a limit of 0; it is a whole number of requests, and must be at least 1`](#defineratelimit-login-has-a-limit-of-0-it-is-a-whole-number-of-requests-and-must-be-at-least-1)
  - [`defineRateLimit: "login" has a per of 0.5; it is a whole number of milliseconds, and must be at least 1`](#defineratelimit-login-has-a-per-of-05-it-is-a-whole-number-of-milliseconds-and-must-be-at-least-1)
  - [`defineRateLimit: "login" has a burst of 0; it is a whole number of requests, and must be at least 1`](#defineratelimit-login-has-a-burst-of-0-it-is-a-whole-number-of-requests-and-must-be-at-least-1)
  - [`defineRateLimit: "archive" has a burst of 1000000 and a per of 31536000000ms; burst × per must be at most 9007199254740 for the script to count exactly`](#defineratelimit-archive-has-a-burst-of-1000000-and-a-per-of-31536000000ms-burst--per-must-be-at-most-9007199254740-for-the-script-to-count-exactly)
  - [`defineRateLimit: "login" would take longer than ten years to refill from empty (burst × per ÷ limit); check that per is in milliseconds`](#defineratelimit-login-would-take-longer-than-ten-years-to-refill-from-empty-burst--per--limit-check-that-per-is-in-milliseconds)
  - [`defineIdempotency: an idempotent operation needs a name, for its keys`](#defineidempotency-an-idempotent-operation-needs-a-name-for-its-keys)
  - [`defineIdempotency: "orders.create" has no key function; it builds the rest of the key from the params`](#defineidempotency-orderscreate-has-no-key-function-it-builds-the-rest-of-the-key-from-the-params)
  - [`defineIdempotency: "orders.create" has a ttl of 0.5; it is a whole number of seconds, and must be at least 1`](#defineidempotency-orderscreate-has-a-ttl-of-05-it-is-a-whole-number-of-seconds-and-must-be-at-least-1)
  - [`defineIdempotency: "orders.create" has a lease of 0; it is a whole number of milliseconds, and must be at least 1`](#defineidempotency-orderscreate-has-a-lease-of-0-it-is-a-whole-number-of-milliseconds-and-must-be-at-least-1)
  - [`defineIdempotency: "orders.create" has no schema; a stored result is checked against one both ways`](#defineidempotency-orderscreate-has-no-schema-a-stored-result-is-checked-against-one-both-ways)
- **Runtime: rate limits**
  - [`enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again`](#enforce-on-login-the-limit-of-5-per-60000ms-is-spent-retryafter-says-when-to-try-again)
  - [`consume on "login": a cost must be a whole number from 1 to the burst of 5`](#consume-on-login-a-cost-must-be-a-whole-number-from-1-to-the-burst-of-5)
  - [`peek on "login": a cost must be a whole number from 0 to the burst of 5`](#peek-on-login-a-cost-must-be-a-whole-number-from-0-to-the-burst-of-5)
  - [A limit allows more than `limit` requests in its first `per`](#a-limit-allows-more-than-limit-requests-in-its-first-per)
  - [A limit barely limits anything](#a-limit-barely-limits-anything)
  - [Every limited caller has to wait much longer than `per`](#every-limited-caller-has-to-wait-much-longer-than-per)
  - [`WRONGTYPE Operation against a key holding the wrong kind of value`](#wrongtype-operation-against-a-key-holding-the-wrong-kind-of-value)
- **Runtime: idempotency**
  - [`run on "orders.create": the same key is still running; retryAfter is when its lease lapses unless renewed`](#run-on-orderscreate-the-same-key-is-still-running-retryafter-is-when-its-lease-lapses-unless-renewed)
  - [`run on "orders.create": this key was first used with a different fingerprint; a repeat must send the same request`](#run-on-orderscreate-this-key-was-first-used-with-a-different-fingerprint-a-repeat-must-send-the-same-request)
  - [`run on "orders.create": the result does not match the schema, so it was not stored (invalid_type)`](#run-on-orderscreate-the-result-does-not-match-the-schema-so-it-was-not-stored-invalid_type)
  - [`run on "orders.create": the result does not match the schema once stored as JSON, so it was not stored (invalid_type)`](#run-on-orderscreate-the-result-does-not-match-the-schema-once-stored-as-json-so-it-was-not-stored-invalid_type)
  - [`run on "orders.create": the result has no JSON form, so it was not stored`](#run-on-orderscreate-the-result-has-no-json-form-so-it-was-not-stored)
  - [`run on "orders.create": the stored result no longer matches the schema, and the work was not run again (invalid_type)`](#run-on-orderscreate-the-stored-result-no-longer-matches-the-schema-and-the-work-was-not-run-again-invalid_type)
  - [`run on "orders.create": the stored record is not one this package wrote, and the work was not run again`](#run-on-orderscreate-the-stored-record-is-not-one-this-package-wrote-and-the-work-was-not-run-again)
  - [`run on "orders.create": the key was taken from this run before it finished (forgotten, or its lease of 30000ms went unrenewed), so a repeat may have run it too; its result was not stored`](#run-on-orderscreate-the-key-was-taken-from-this-run-before-it-finished-forgotten-or-its-lease-of-30000ms-went-unrenewed-so-a-repeat-may-have-run-it-too-its-result-was-not-stored)
  - [`run: a fingerprint is a string or an ArrayBufferView, such as the raw body`](#run-a-fingerprint-is-a-string-or-an-arraybufferview-such-as-the-raw-body)
  - [`run on "orders.create": wait is a whole number of milliseconds, 0 or more`](#run-on-orderscreate-wait-is-a-whole-number-of-milliseconds-0-or-more)
  - [The same request ran twice](#the-same-request-ran-twice)
  - [`WRONGTYPE Operation against a key holding the wrong kind of value`](#wrongtype-operation-against-a-key-holding-the-wrong-kind-of-value) — a key that is not a hash; the entry is under rate limits
- **Runtime: Redis itself**
  - [`Connection closed`](#connection-closed)

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

### `Cannot find module 'zod' or its corresponding type declarations.`

**When:** typechecking, reported in this package's own declarations
(`dist/idempotency/types.d.ts` and its neighbours), in a project where `zod`
is not installed — peers turned off (`peer = false` under `[install]` in
`bunfig.toml`), or an installer that leaves peers out. Bun installs a missing
peer by itself otherwise. Running the code does not fail: nothing in it
loads `zod`.
**Why:** `zod` is a required peer since 0.2.0, for the **types** only: every
import of it in this package is `import type`, so nothing loads it at run
time — `run` calls the `safeParseAsync` of the schema you pass. The shipped
declarations name `z.ZodType`, `z.input` and `z.output`, so only `tsc` looks
for the module. With `skipLibCheck: true` it does not report it at all: the
zod types become `any`, a `schema` of any value compiles, and `run`'s
`value` is typed `any`.
**Fix:** install it beside the package, so your schemas and its
declarations resolve the same copy:

```sh
bun add zod
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

### `defineIdempotency: an idempotent operation needs a name, for its keys`

**When:** at import, on a definition whose `name` is `''`.
**Why:** a stored key is `<name>:<key(params)>`. Without a name, two
operations keyed by the same client key would replay each other's results.
**Fix:** name it after the operation — `orders.create`, `payments.charge`.

### `defineIdempotency: "orders.create" has no key function; it builds the rest of the key from the params`

**When:** at import, on a `key` that is not a function.
**Why:** the key is built from each call's params; a fixed string would make
every request after the first a replay of it.
**Fix:**

```ts
key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
```

### `defineIdempotency: "orders.create" has a ttl of 0.5; it is a whole number of seconds, and must be at least 1`

**When:** at import, on a `ttl` that is 0, negative, fractional, `NaN` or
infinite. The message quotes the value it was given.
**Why:** `ttl` is Redis's `EXPIRE`, in whole **seconds**, as `defineCache`'s
is in `@nxgt/redis`. A `ttl` written in milliseconds is not refused — it is
just a thousand times too long — so check the unit when it looks large.
**Fix:**

```ts
ttl: 86_400,   // a day, in seconds
```

### `defineIdempotency: "orders.create" has a lease of 0; it is a whole number of milliseconds, and must be at least 1`

**When:** at import, on a `lease` that is given and is not a whole number of
at least 1.
**Why:** `lease` is how long the in-flight marker lives, in **milliseconds**.
**Fix:** leave it out for the default of 10 s, or give it in milliseconds.
The heartbeat renews it while `work` runs, so it need not cover the work —
only how long a crashed run may hold the key; keep it above the longest the
event loop may be blocked or Redis unreachable:

```ts
lease: 30_000,
```

### `defineIdempotency: "orders.create" has no schema; a stored result is checked against one both ways`

**When:** at import, on a definition with no `schema`, or one that is not a
zod schema.
**Why:** every result is parsed on the way in and on every replay; there is
no unchecked mode.
**Fix:** describe the result, however small:

```ts
schema: z.object({ orderId: z.string() }),
```

## Runtime: rate limits

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
refill or empty a bucket. A clock that goes back never refills: each bucket
keeps the latest time it has seen and carries on from there, so two servers
whose clocks disagree by at most one full refill (`burst × per ÷ limit`)
cannot count one stretch of time twice. While the clock is behind that time,
nothing refills, and a spent bucket waits for the clock to catch up. Only
that clock wait is capped, at one full refill; a spent bucket's `retryAfter`
is the clock wait **plus** the usual wait for the requests it needs. A clock
further behind than one full refill finds the bucket full instead — so a
single jump back that far allows one extra burst, and two clocks that far
apart, alternating, allow a full burst at each switch. A `peek` from a
clock that far behind writes nothing, so it is not a promise: once the
clock is back within a full refill, the stored state counts again.
**Fix:** keep the Redis servers' clocks synchronised (NTP). To release every
caller at once after a clock mistake, delete the limit's keys — they hold
nothing else:

```sh
redis-cli --scan --pattern 'login:*' | xargs -r redis-cli del
```

### `WRONGTYPE Operation against a key holding the wrong kind of value`

**When:** `consume`, `enforce` or `peek` on a limit, when a key under its
name — `<name>:<key>` — holds a hash, a list, a set or anything but a string.
This also happens to `run` on an idempotent operation, when its key holds
anything but a hash — the script reads it with `HLEN` — and `forget`
deletes it, as `reset` does.
**Why:** the script reads the key with `GET`, and Redis refuses `GET` on a
key of another type. The error is Redis's own, passed through as Bun's
`RedisError`, not a `GuardError`: nothing was decided. A *string* the script
could not have written is different — it reads as a full bucket and the
next allowed call replaces it.
`reset` does not fail here: it runs `DEL`, which takes any type, so it
deletes the clashing key — somebody else's live data as readily as a
leftover.
**Fix:** give the limit a name no other part of the application uses as a
key prefix, or delete the clashing key if it is left over:

```ts
const loginLimit = defineRateLimit({
	name: 'ratelimit:login', // not 'login', which the sessions also use
	key: (p: { ip: string }) => p.ip,
	limit: 5,
	per: 60_000,
});
```

## Runtime: idempotency

### `run on "orders.create": the same key is still running; retryAfter is when its lease lapses unless renewed`

**When:** `run` found the key taken by a run that has not finished — the
client retried before the first request was answered, or sent two at once —
and either no `wait` was given, or the first run was still going when it ran
out. It is a `GuardError` with code `IN_PROGRESS` and `retryAfter`, the
milliseconds before the running call's lease lapses **if it stops being
renewed**. `work` was not called.
**Why:** running it beside the first is what idempotency exists to prevent,
and there is no result yet to replay. A live run renews its lease every
third of it, so `retryAfter` is not when the work will finish: it is the
longest a crashed run can hold the key.
**Fix:** give `run` a `wait`, so most repeats get the replay rather than
this error, and answer what is left with 409 and `Retry-After`, in whole
seconds rounded up:

```ts
try {
	return await orders.run(who, work, { fingerprint: body, wait: 2_000 });
} catch (error) {
	if (error instanceof GuardError && error.code === 'IN_PROGRESS') {
		return new Response('Still running', {
			status: 409,
			headers: { 'Retry-After': String(Math.ceil((error.retryAfter ?? 0) / 1000)) },
		});
	}
	throw error;
}
```

If it keeps coming long after the first request, a run is holding the key
without finishing: `work` is stuck — the renewals keep its key alive for as
long as it runs — or a process died mid-work, and the key frees itself once
`retryAfter` has passed. `forget` frees it at once, when you know which.

### `run on "orders.create": this key was first used with a different fingerprint; a repeat must send the same request`

**When:** the key was first used with one fingerprint and this call has
another — or has one where the first had none, or the reverse. It is a
`GuardError` with code `MISMATCH`, whether the first run has finished or is
still running. `work` was not called.
**Why:** a key reused for a different request would otherwise be answered
with the first request's result.
**Fix:** a client error: answer 422. If identical requests get it, the
fingerprint is not stable — it was built from a re-serialised object, or
includes something that changes per attempt (a timestamp, a request id).
Fingerprint the raw body:

```ts
const body = await request.text();
await orders.run({ user, key }, () => placeOrder(JSON.parse(body)), { fingerprint: body });
```

### `run on "orders.create": the result does not match the schema, so it was not stored (invalid_type)`

**When:** `work` returned something the definition's schema refuses. It is a
`GuardError` with code `INVALID`; the key was given back, so the next call
runs `work` again. The parenthesis lists zod's issue codes.
**Why:** a result is only stored as the schema gives it back, so that every
replay can read it.
**Fix:** make `work` return what the schema accepts, or widen the schema. The
codes only say what kind of mismatch; to see where, parse the value yourself
in a test — the message never carries zod's messages or paths, which can
quote the value.

```ts
console.log(createOrder.schema.safeParse(await placeOrder(body)).error?.issues);
```

### `run on "orders.create": the result does not match the schema once stored as JSON, so it was not stored (invalid_type)`

**When:** `work`'s result matched the schema, but after `JSON.stringify` and
`JSON.parse` it no longer does. Code `INVALID`; the key was given back.
**Why:** a result is stored as JSON and parsed again on each replay. A
`z.date()` becomes a string on the way; a transform whose output its own
input does not accept cannot be parsed twice. Refusing now is better than
storing a result that every replay for the whole `ttl` would refuse.
**Fix:** store what JSON keeps:

```ts
schema: z.object({ at: z.iso.datetime() }),   // not z.date()
// and in work: return { at: new Date().toISOString() };
```

### `run on "orders.create": the result has no JSON form, so it was not stored`

**When:** `JSON.stringify` of the parsed result threw or gave nothing — a
`bigint`, a cycle, `undefined`. Code `INVALID`; the key was given back.
**Why:** a result is stored as JSON.
**Fix:** return a JSON value: a `bigint` as a string, `null` rather than
`undefined`.

### `run on "orders.create": the stored result no longer matches the schema, and the work was not run again (invalid_type)`

**When:** a replay found a result the schema, as it is **now**, refuses —
almost always a deploy that changed the schema while results written by the
previous one were still within their `ttl`. Code `INVALID`. The stored result
is kept and `work` was **not** called.
**Why:** the stored result stands for something that already happened.
Treating it as a miss would run `work` a second time — a second order, a
second charge.
**Fix:** make the schema read the old shape — a new field `.optional()` or
with a `.default()` — or rename the operation so old results stay under the
old name. To run a key again deliberately, `forget` it:

```ts
await orders.forget({ user, key });
```

### `run on "orders.create": the stored record is not one this package wrote, and the work was not run again`

**When:** the hash at the key is not one of the two shapes `run` writes —
three fields, a known state, a well-formed fingerprint and token, and an
expiry. A hand edit, a `PERSIST`, or another part of the application using
the same name as a prefix. Code `INVALID`; the record is left alone and
`work` was not called. Also a done result whose value is not JSON.
**Why:** reading an unknown record as free would run `work` again beside
whatever it stood for; reading it as a mismatch would blame the client.
**Fix:** give the operation a name nothing else uses as a prefix, and
`forget` the key once you know what it was.

### `run on "orders.create": the key was taken from this run before it finished (forgotten, or its lease of 30000ms went unrenewed), so a repeat may have run it too; its result was not stored`

**When:** `work` finished, but the key had been taken from this run while it
ran, so nothing was stored. Code `LEASE_LOST`. One of:

- `forget` was called for the key during the run, or something else deleted
  it;
- no renewal reached Redis for a whole `lease`, so the key lapsed — Redis
  unreachable that long, or the event loop **blocked by synchronous work**
  that long, since the renewal timer cannot fire meanwhile. A repeat may then
  have taken the key and run `work` too.

**Why:** the lease is renewed every third of it while `work` runs, and each
renewal checks the key still holds this run's token. Once one finds the key
gone or another run's, nothing can give it back, and storing this result
could overwrite the other run's — so it is refused. `work` itself is not
interrupted.
**Fix:** treat it as "check for a duplicate". Then stop the event loop from
being held for a whole lease: the lease bounds how long a crashed run holds
the key, not how long `work` may take, so the fix is in `work`, not a longer
lease. Yield between chunks of synchronous work, or move it to a `Worker`:

```ts
const { value } = await orders.run(who, async () => {
	const lines: string[] = [];
	for (const [i, row] of rows.entries()) {
		lines.push(render(row)); // synchronous
		if (i % 1_000 === 999) await Bun.sleep(0); // the renewal timer can fire
	}
	return { orderId: await store(lines.join('\n')) };
});
```

Raise `lease` only above the longest Redis may be unreachable, which the
renewals cannot cover; a longer lease also keeps a crashed run's key for
longer.

### `run: a fingerprint is a string or an ArrayBufferView, such as the raw body`

**When:** `fingerprint` was given something else — a number, a plain object —
past the types. A bare `TypeError`; the promise rejects before anything is
sent.
**Why:** the fingerprint is hashed with SHA-256 over exactly the bytes it
stands for — a string's UTF-8, or the bytes an `ArrayBufferView` covers.
Anything else has no one set of bytes: `String(42)` or a re-serialised object
could differ between two identical requests, or agree between two different
ones, and a key reused for another request would then replay the wrong
result. It is a `TypeError` rather than a `GuardError` because the value's
type is the code's mistake, not the client's.
**Fix:** pass the body as text or bytes; to fingerprint an object, pass the
text it was parsed from:

```ts
const body = await request.text();
await orders.run(who, () => placeOrder(JSON.parse(body)), { fingerprint: body });
```

### `run on "orders.create": wait is a whole number of milliseconds, 0 or more`

**When:** `run`'s `wait` was not a whole number of 0 or more — a negative
number, a fraction, `NaN`, `Infinity`, a string such as `'2s'`, or `null` —
past the types. A bare `TypeError`; the promise rejects before anything is
sent. The message quotes no value.
**Fix:** pass milliseconds as a whole number, or leave `wait` out for none:

```ts
await orders.run(who, work, { wait: 2_000 });
```

### The same request ran twice

**When:** two requests with the same key both ran `work`.
**Why**, one of:

- the first lost its key — no renewal reached Redis for a whole `lease`
  (Redis unreachable, or the event loop blocked by synchronous work), or it
  was `forget`-ed — and the second arrived after that; the first then failed
  with `LEASE_LOST`;
- the first **threw**, which gives the key back, so the second ran again (by
  design: an error is not a result);
- **Redis failed between `work` and storing its result** — the connection
  dropped, or the server refused the write. The first `run` rejected with
  Redis's own error (see [`Connection closed`](#connection-closed)), after
  `work` had done what it does. Nothing renews the key any more and nothing
  gives it back, so it stays running until its lease lapses: a repeat before
  then gets `IN_PROGRESS`, and one after it runs `work` again;
- the second came after `ttl` seconds;
- the two keys were not the same: `key(params)` differs, or the two
  definitions have different `name`s.

**Fix:** synchronous work off the event loop, and a `lease` above the
longest outage; a failure that must replay returned as a union
member rather than thrown; a longer `ttl`. `keyFor(params)` shows the key a
call would use. A Redis error from `run` means the work **may** have
happened: make `work` itself safe to repeat where it can — an upsert on an id
you derive from the key, or a provider's own idempotency key:

```ts
await orders.run(who, async () => {
	// The provider refuses a second charge with the same key, whoever sends it.
	const charge = await provider.charge(amount, { idempotencyKey: orders.keyFor(who) });
	return { orderId: charge.id };
});
```

## Runtime: Redis itself

### `Connection closed`

**When:** any call, while Redis cannot be reached — `consume`, `enforce`,
`peek` and `reset` on a limit, `run` and `forget` on an idempotent operation.
It is Bun's `RedisError`, not a `GuardError`: measured on Bun 1.4.2, `name`
is `'RedisError'` and `code` is `'ERR_REDIS_CONNECTION_CLOSED'`, and the
message is `Connection closed`, or `Max reconnection attempts reached` once
Bun's client has given up reconnecting — which it tries first, so the call
can take seconds to reject. Any other server error comes back the same way.
**Why:** this package opens no connection of its own, retries nothing and
has no fallback: every step is one script, or a `DEL`, on your `RedisClient`,
and an error from it passes through as it is, not wrapped. Where it happens
in `run` decides what it means:

| Redis failed | `run` | `work` |
| --- | --- | --- |
| taking the key, or polling it during `wait` | rejects with Redis's error | not called |
| renewing the lease while `work` runs | nothing: tried again at the next beat | runs on; the lease is lost only if no renewal gets through for a whole `lease` |
| storing the result | rejects with Redis's error; the key stays running until its lease lapses | **has run** — see [The same request ran twice](#the-same-request-ran-twice) |
| giving the key back after `work` threw | rejects with `work`'s own error; the key lapses with its lease | threw |

On a limit, a failed check may or may not have counted: the script is one
atomic step, but its reply can be lost after it ran.
**Fix:** answer it where the request is answered — a 503 rather than a 500,
since the request itself was fine — and decide per route whether a limit
that cannot be checked lets the caller through:

```ts
/** A 503 for Redis's own errors; undefined for anything else. */
export function redisUnavailable(error: unknown): Response | undefined {
	if (error instanceof Error && error.name === 'RedisError') {
		return new Response('Try again shortly', { status: 503, headers: { 'Retry-After': '5' } });
	}
	return undefined;
}
```

The [roadmap](roadmap.md#not-planned) says why there is no in-memory
fallback.

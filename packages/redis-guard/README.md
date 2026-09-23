# @nxgt/redis-guard

Guards on **Bun's own Redis client**, each described once, keyed by a typed
function, and checked by atomic scripts on the server — timed by the **Redis
server's clock**, so every process sharing the Redis agrees:

- **rate limits** — so many requests per window, per caller;
- **idempotency** — run an operation once per key, and replay its result to
  every repeat.

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

> **0.x.** Rate limits and idempotency are here, with a lease renewed while
> the work runs and `wait` for a running key — see the
> [roadmap](docs/roadmap.md).

## Install

```sh
bun add @nxgt/redis-guard zod
bun add -d @types/bun typescript
```

- **Bun 1.4 or later, and Bun only.** It takes Bun's `RedisClient`, which is
  built into Bun — so there is no driver to install, and it does not run on
  Node.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package
  pins.
- `zod` `>=4.6.5 <5`: required peer, since 0.2.0, **for the types**. Nothing
  here loads zod at run time — an idempotent result is checked by calling the
  schema you pass — but the declarations name `z.ZodType`, `z.input` and
  `z.output`, so `tsc` needs zod beside the package, and a schema from
  another copy of zod than the one they resolve fails to typecheck. A rate
  limit uses none of it, but the peer is required all the same.
- `@types/bun`: required to typecheck. The shipped declarations name Bun's
  `RedisClient`, so without Bun's types the first `tsc` fails with
  `Cannot find module 'bun'`.
- It depends on no other `@nxgt` package. Any `RedisClient` will do — your
  own, or the `client` of an `@nxgt/redis` connection.
- Tested against Redis 7.4. It needs `EVALSHA`, `EVAL` and `TIME` in a
  script.

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

It is **GCRA**, one Lua script over one key, in exact integers; a denial and
a `peek` write nothing, and an idle limit leaves no key. The
[rate limits guide](docs/guide/rate-limits.md) has the algorithm, choosing
`burst`, and the `RateLimit-*` headers.

## Idempotency

```ts
import { RedisClient } from 'bun';
import { z } from 'zod';
import { bindIdempotency, defineIdempotency, GuardError } from '@nxgt/redis-guard';

const redis = new RedisClient(process.env.REDIS_URL);

export const createOrder = defineIdempotency({
	name: 'orders.create',
	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
	ttl: 86_400,        // SECONDS a finished result is replayed
	lease: 30_000,      // MILLISECONDS a crashed run holds the key — see Traps
	schema: z.object({
		orderId: z.string(),
		status: z.string().default('placed'),
	}),
});

const orders = bindIdempotency(redis, createOrder);

async function postOrder(request: Request, user: string): Promise<Response> {
	const key = request.headers.get('Idempotency-Key');
	if (!key) return new Response('Idempotency-Key is required', { status: 400 });
	const body = await request.text();
	try {
		const { value, replayed } = await orders.run(
			{ user, key },
			() => placeOrder(JSON.parse(body)),   // returns { orderId }
			{ fingerprint: body, wait: 2_000 },  // the raw body, hashed; ms to wait
		);
		return Response.json(value, {
			status: 201,
			headers: replayed ? { 'Idempotent-Replayed': 'true' } : {},
		});
	} catch (error) {
		if (error instanceof GuardError && error.code === 'IN_PROGRESS') {
			const seconds = Math.ceil((error.retryAfter ?? 0) / 1000);
			return new Response('Still running', {
				status: 409,
				headers: { 'Retry-After': String(seconds) },
			});
		}
		if (error instanceof GuardError && error.code === 'MISMATCH') {
			return new Response('This key was used for another request', { status: 422 });
		}
		throw error;
	}
}
```

A repeat within `ttl` gets the stored result, `replayed: true`, without
calling `work`; one during the first run waits up to `wait` ms for it, and
gets `IN_PROGRESS` if it is still running. **A thrown error is never
stored**, so a failure the client must get back on every repeat is returned
as a union member:

```ts
export const chargeCard = defineIdempotency({
	name: 'payments.charge',
	key: (key: string) => key,
	ttl: 86_400,
	schema: z.discriminatedUnion('ok', [
		z.object({ ok: z.literal(true), chargeId: z.string() }),
		z.object({ ok: z.literal(false), reason: z.string() }),
	]),
});

const { value } = await bindIdempotency(redis, chargeCard).run(key, async () => {
	const charge = await provider.charge(amount);
	return charge.declined
		? { ok: false as const, reason: charge.declineCode }
		: { ok: true as const, chargeId: charge.id };
});
```

The [idempotency guide](docs/guide/idempotency.md) has the fingerprint, the
lease and its renewals, `wait`, the storage, and the HTTP recipe in full;
[testing](docs/guide/testing.md) shows specs for both primitives.

## API

| Function | |
| --- | --- |
| `defineRateLimit({ name, key, limit, per, burst? })` | describes a rate limit; talks to nothing. Frozen. A definition that could never work is a bare `TypeError`, normally at import |
| `bindRateLimit(client, definition)` | binds it to a `RedisClient`. Checks the definition again, for one written by hand |
| `defineIdempotency({ name, key, ttl, lease?, schema })` | describes an idempotent operation; talks to nothing. Frozen. A definition that could never work is a bare `TypeError` |
| `bindIdempotency(client, definition)` | binds it to a `RedisClient`. Checks the definition again |

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

| `IdempotencyDefinition<P, S>` | |
| --- | --- |
| `name` | the key's prefix. A stored key is `` `<name>:<key(params)>` `` |
| `key(params)` | the rest of the key — usually the client's `Idempotency-Key`, scoped to its user |
| `ttl` | how long a finished result is replayed, **in seconds**. A whole number, at least 1 |
| `lease` | how long a run holds the key unless renewed, **in milliseconds**. Default `10_000`. Renewed every third of it while `work` runs, so it bounds how long a **crashed** run holds the key, not how long `work` may take |
| `schema` | a zod schema for the result, checked on the way in and on every replay |

| `BoundIdempotency<P, T, I>` | |
| --- | --- |
| `keyFor(params)` | the key it would use |
| `run(params, work, { fingerprint?, wait? })` | runs `work` once per key, and replays its result. `work` returns what the schema accepts (`I`); `run` resolves to `{ value, replayed }`, `value` as the schema gives it back (`T`) |
| `forget(params)` | deletes the key, finished or running. `true` when something was there |

`fingerprint` is a string or an `ArrayBufferView` — the raw body, usually.
Only its SHA-256 is stored. `wait` is how long to wait for a run of the same
key that is still going, **in milliseconds** — a whole number, default `0`:
`run` polls the key until it is done (a replay), free (it runs `work`), or
the time is spent (`IN_PROGRESS`). A `MISMATCH` or an `INVALID` ends it at
once.

| Type | |
| --- | --- |
| `RateLimitDefinition<P>` | what `defineRateLimit` takes and gives back |
| `BoundRateLimit<P>` | what `bindRateLimit` gives back |
| `LimitResult` | what every check answers |
| `IdempotencyDefinition<P, S>` | what `defineIdempotency` takes and gives back |
| `BoundIdempotency<P, T, I>` | what `bindIdempotency` gives back |
| `Idempotent<T>` | what `run` resolves to: `{ value, replayed }` |
| `RunOptions` | `run`'s options: `{ fingerprint?, wait? }` |
| `GuardError`, `GuardErrorCode` | the error, and its codes |

## Errors

`GuardError` is what this package throws, with a `code` and the `definition`
it happened on — its `name`, never the key it built nor the params, which
came from a request.

| `GuardErrorCode` | | |
| --- | --- | --- |
| `RATE_LIMITED` | `enforce` found the limit spent. Carries `retryAfter`, in milliseconds | `enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again` |
| `COST` | a cost that is not a whole number from 1 (0 for `peek`) to the burst | `consume on "login": a cost must be a whole number from 1 to the burst of 5` |
| `IN_PROGRESS` | `run` found the key still running — at once, or when its `wait` ran out. Carries `retryAfter`: milliseconds until that run's lease lapses **unless renewed**, which a live run does | `run on "orders.create": the same key is still running; retryAfter is when its lease lapses unless renewed` |
| `MISMATCH` | `run` found the key first used with a different fingerprint — or with one where this call has none, or the reverse | `run on "orders.create": this key was first used with a different fingerprint; a repeat must send the same request` |
| `INVALID` | what `work` returned does not match the schema — not stored, key given back; or what was stored no longer does — kept, and `work` **not** run again; or the record at the key is not one `run` wrote | `run on "orders.create": the result does not match the schema, so it was not stored (invalid_type)` |
| `LEASE_LOST` | the key was taken from the run before it finished — `forget`, or its lease lapsed because no renewal reached Redis for a whole lease — so a repeat may have run `work` too. Its result was not stored | `run on "orders.create": the key was taken from this run before it finished (forgotten, or its lease of 30000ms went unrenewed), so a repeat may have run it too; its result was not stored` |

An `INVALID` message lists zod's issue **codes** only — never zod's messages
nor the paths, which can quote what the value held.

**`TypeError`s come earlier, at definition time**, and normally at import:
`defineRateLimit` (and `bindRateLimit`, for a definition written by hand)
refuses an empty `name`, a `key` that is not a function, a `limit`, `per` or
`burst` that is not a whole number of at least 1, a `burst × per` above
9,007,199,254,740 (the most the script counts exactly), and a rate that would
take more than ten years to refill from empty; `defineIdempotency` (and
`bindIdempotency`) refuses an empty `name`, a `key` that is not a function, a
`ttl` or `lease` that is not a whole number of at least 1, and a missing
`schema`. A `fingerprint` that is neither a string nor an `ArrayBufferView`,
and a `wait` that is not a whole number of 0 or more, reject with a
`TypeError` before anything is sent. Redis's own failures come back as
they are, from Bun's client — [`Connection closed`](docs/troubleshooting.md#connection-closed)
says what each means in `run`. Every message is in
[troubleshooting](docs/troubleshooting.md).

## What does not compile

Each is a `@ts-expect-error` case in [`test/types/guard.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/redis-guard/test/types/guard.ts), which the package does not ship.

- A call with the wrong params, or with some of them missing.
- A `cost` that is a string — `consume(params, '2')`.
- A definition without `per`, `limit` or `key`, a `per` or a `burst` given as
  a string, a `key` that gives anything but a string, and an option it does
  not have — `window` for `per`.
- `reset` with a cost, a `LimitResult` written to, a definition changed after
  it is defined, and `bindRateLimit` without a client.
- A `GuardErrorCode` it does not have, and `retryAfter` read as if it were
  always there.

In [`test/types/idempotency.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/redis-guard/test/types/idempotency.ts):

- A `work` that returns what the schema does not accept — a field of the
  wrong type, a required field left out, a union member the schema lacks.
- A `fingerprint` that is a number, a `wait` given as a string or a boolean,
  a `timeout` for `wait`, params missing a field, `forget` with a bare
  string, and a result written to.
- A definition without `ttl` or `schema`, a `ttl` given as a string, an
  option it does not have — `timeout` for `lease` — a `lease` given as a
  string, a definition changed after it is defined, and `bindIdempotency`
  without a client.
- A rate limit handed to `bindIdempotency`, and an idempotent operation
  handed to `bindRateLimit`.

## Traps

Rate limits:

- **GCRA is a rate, not a window count**: after an idle spell, the first
  `per` allows up to `burst + limit − 1` requests (9 for 5 a minute).
  `burst: 2` holds it down — [why](docs/troubleshooting.md#a-limit-allows-more-than-limit-requests-in-its-first-per).
- **`per` is milliseconds**, and nothing can refuse `per: 60`, which limits
  almost nothing. `per: 60_000` is a minute — [more](docs/troubleshooting.md#a-limit-barely-limits-anything).
- **`burst × per` is at most 9,007,199,254,740**, and `burst` defaults to
  `limit`, or the definition throws. `limit: 1_000, per: 86_400_000` rather
  than a million a year — [more](docs/troubleshooting.md#defineratelimit-archive-has-a-burst-of-1000000-and-a-per-of-31536000000ms-burst--per-must-be-at-most-9007199254740-for-the-script-to-count-exactly).
- **The clock is the Redis server's**, so a failover to a server whose clock
  is behind holds spent buckets until it catches up, and more than one full
  refill behind allows an extra burst. Keep the servers on NTP — [more](docs/troubleshooting.md#every-limited-caller-has-to-wait-much-longer-than-per).
- **Every process must use the same definition**: two rates under one `name`
  share one key. `name: 'login.v2'` when the rate changes a lot —
  [the key](docs/guide/rate-limits.md#describing-a-limit).
- **A cost beyond what is left is denied and counts nothing; one beyond the
  burst rejects with `COST`.** Check `cost <= (exportLimit.burst ?? exportLimit.limit)`
  where a request sets it — [more](docs/troubleshooting.md#consume-on-login-a-cost-must-be-a-whole-number-from-1-to-the-burst-of-5).

Idempotency:

- **Synchronous work can lose the lease**: the renewal timer cannot fire
  while the event loop is blocked, so after a whole `lease` a repeat runs
  `work` again and the first rejects with `LEASE_LOST`. `await Bun.sleep(0)`
  between chunks, or a `Worker` — [the lease](docs/guide/idempotency.md#the-lease).
- **`ttl` is seconds; `lease` is milliseconds.** `ttl: 86_400` is a day;
  `lease: 86_400` is under a minute and a half — [choosing them](docs/guide/idempotency.md#choosing-ttl-and-lease).
- **A thrown error is not stored**, so the next repeat runs again. Return a
  failure that must replay as a union member of the schema — [example](docs/guide/idempotency.md#a-failure-worth-replaying-is-a-result).
- **A replay parses with today's schema**, and a stored result it refuses is
  `INVALID`, not run again. Add fields with `.optional()` or `.default()` —
  [changing the schema](docs/guide/idempotency.md#changing-the-schema).
- **A result must survive JSON**: a `z.date()` or a `bigint` is refused on
  the first run. `z.iso.datetime()` and a string — [more](docs/troubleshooting.md#run-on-orderscreate-the-result-does-not-match-the-schema-once-stored-as-json-so-it-was-not-stored-invalid_type).
- **Fingerprint the raw body**, not `JSON.stringify` of a parsed one, or
  identical requests can mismatch. `{ fingerprint: await request.text() }` —
  [the fingerprint](docs/guide/idempotency.md#the-fingerprint).
- **Scope the key**: an `Idempotency-Key` is unique only to its client.
  `` key: (p) => `${p.user}/${p.key}` `` —
  [describing an operation](docs/guide/idempotency.md#describing-an-operation).
- **A Redis error after `work` means the work happened**, and the key may stay
  running until its lease lapses, then runs again. Make `work` safe to repeat
  where it can be — [the same request ran twice](docs/troubleshooting.md#the-same-request-ran-twice).
- **`wait` holds the request open** while it polls. Keep it under your HTTP
  timeout: `wait: 2_000` — [waiting](docs/guide/idempotency.md#waiting-for-a-running-key).

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/rate-limits.md](docs/guide/rate-limits.md) — GCRA, choosing a
  rate, and the HTTP recipe.
- [docs/guide/idempotency.md](docs/guide/idempotency.md) — the storage, the
  fingerprint, `ttl` and `lease`, and the HTTP recipe.
- [docs/guide/testing.md](docs/guide/testing.md) — specs against a real
  Redis, emptying it between tests, and why the host's clock refills
  nothing.
- [docs/upgrading.md](docs/upgrading.md) — what to change from 0.1.0 and
  0.2.0.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT

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

> **0.x.** Rate limits and idempotency are here; an idempotent run's lease is
> not renewed yet, and waiting for a running key is next — see the
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
- `zod` `>=4.6.5 <5`: required peer, since 0.2.0. An idempotent result is
  checked against your schema both ways, so your copy of zod has to be the one
  it parses with. A rate limit parses nothing, but the peer is required all
  the same.
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

The algorithm is **GCRA** (the generic cell rate algorithm), counted in
**exact integers**: one Redis string per key holds two whole numbers — the
latest server time the bucket has seen, and how far it was then from full —
and one Lua script reads it, decides and writes, in a single step. Nothing is
rounded, so a burst taken one request at a time allows exactly the burst, at
any rate. A denial writes nothing, a `peek`
writes nothing, and the key expires when the bucket is full again, so an idle
limit leaves nothing in Redis.

The [rate limits guide](docs/guide/rate-limits.md) has the algorithm in
detail, choosing `limit`, `per` and `burst`, and an HTTP recipe with the
`RateLimit-*` and `Retry-After` headers for any framework.

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
	lease: 30_000,      // MILLISECONDS the work may take — see Traps
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
			{ fingerprint: body },               // the raw body, hashed
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

The first call with a key runs `work` and stores what it returned; every
repeat within `ttl` gets that result back — `replayed: true` — and `work` is
not called. A repeat that arrives while the first is still running is
refused with `IN_PROGRESS`, and one with a different fingerprint with
`MISMATCH`. **An error thrown by `work` is never stored**: the key is given
back and the error passes through as it is, so the next call runs again.

A failure the client should get back on every repeat — a card declined, not a
database that was down — is a **result**, not an error: return it as one
member of a union schema.

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

Each step is one Lua script over one hash: taking the key, storing the
result under this run's own token, and giving the key back. The
[idempotency guide](docs/guide/idempotency.md) has the storage, the
fingerprint, choosing `ttl` and `lease`, and the HTTP recipe in full.

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
| `lease` | how long the work may take before a repeat may run it again, **in milliseconds**. Default `10_000`. Not renewed — see Traps |
| `schema` | a zod schema for the result, checked on the way in and on every replay |

| `BoundIdempotency<P, T, I>` | |
| --- | --- |
| `keyFor(params)` | the key it would use |
| `run(params, work, { fingerprint? })` | runs `work` once per key, and replays its result. `work` returns what the schema accepts (`I`); `run` resolves to `{ value, replayed }`, `value` as the schema gives it back (`T`) |
| `forget(params)` | deletes the key, finished or running. `true` when something was there |

`fingerprint` is a string or an `ArrayBufferView` — the raw body, usually.
Only its SHA-256 is stored.

| Type | |
| --- | --- |
| `RateLimitDefinition<P>` | what `defineRateLimit` takes and gives back |
| `BoundRateLimit<P>` | what `bindRateLimit` gives back |
| `LimitResult` | what every check answers |
| `IdempotencyDefinition<P, S>` | what `defineIdempotency` takes and gives back |
| `BoundIdempotency<P, T, I>` | what `bindIdempotency` gives back |
| `Idempotent<T>` | what `run` resolves to: `{ value, replayed }` |
| `RunOptions` | `run`'s options: `{ fingerprint? }` |
| `GuardError`, `GuardErrorCode` | the error, and its codes |

## Errors

`GuardError` is what this package throws, with a `code` and the `definition`
it happened on — its `name`, never the key it built nor the params, which
came from a request.

| `GuardErrorCode` | | |
| --- | --- | --- |
| `RATE_LIMITED` | `enforce` found the limit spent. Carries `retryAfter`, in milliseconds | `enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again` |
| `COST` | a cost that is not a whole number from 1 (0 for `peek`) to the burst | `consume on "login": a cost must be a whole number from 1 to the burst of 5` |
| `IN_PROGRESS` | `run` found the key still running. Carries `retryAfter`: milliseconds until its lease ends | `run on "orders.create": the same key is still running; retryAfter says when its lease ends` |
| `MISMATCH` | `run` found the key first used with a different fingerprint — or with one where this call has none, or the reverse | `run on "orders.create": this key was first used with a different fingerprint; a repeat must send the same request` |
| `INVALID` | what `work` returned does not match the schema — not stored, key given back; or what was stored no longer does — kept, and `work` **not** run again; or the record at the key is not one `run` wrote | `run on "orders.create": the result does not match the schema, so it was not stored (invalid_type)` |
| `LEASE_LOST` | `work` finished after its lease lapsed, so a repeat may have run it too. Its result was not stored | `run on "orders.create": the work outlasted its lease of 30000ms, so a repeat may have run it too; its result was not stored` |

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
`schema`. A `fingerprint` that is neither a string nor an `ArrayBufferView`
rejects with a `TypeError` before anything is sent. Redis's own failures come back as
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

In `test/types/idempotency.ts`:

- A `work` that returns what the schema does not accept — a field of the
  wrong type, a required field left out, a union member the schema lacks.
- A `fingerprint` that is a number, params missing a field, `forget` with a
  bare string, and a result written to.
- A definition without `ttl` or `schema`, a `ttl` given as a string, an
  option it does not have — `timeout` for `lease` — a `lease` given as a
  string, a definition changed after it is defined, and `bindIdempotency`
  without a client.
- A rate limit handed to `bindIdempotency`, and an idempotent operation
  handed to `bindRateLimit`.

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
- **`burst × per` is at most 9,007,199,254,740** — and `burst` defaults to
  `limit`, so a very large `limit` with no `burst` counts too. The script
  counts a full bucket as `burst × per × 1000` whole units, and a Lua number holds whole
  numbers exactly only up to `Number.MAX_SAFE_INTEGER`. Any rate is fine —
  there is no bound on requests per millisecond — but a burst of a million
  over a `per` of a year is refused at definition.
- **Bun only.** It takes Bun's `RedisClient`, and runs on Node never.
- **The clock is the Redis server's.** `now` is read with `TIME` inside the
  script, so a host with a wrong clock cannot refill a bucket or empty one,
  and every process agrees. Two consequences: a result is a delay, which means
  the same on every host, and **a server clock that goes back never
  refills**: a bucket keeps the latest time it has seen and carries on from
  there, so a failover between two servers whose clocks disagree by **at
  most one full refill** (`burst × per ÷ limit`) cannot count the same
  stretch of time twice. While the clock is behind, nothing refills — a spent
  bucket waits for the clock to catch up, and `retryAfter` is that wait plus
  the usual one. Past one full refill the guarantee stops: a clock that far
  behind a bucket finds it full, so a single jump back allows one extra
  burst, and two clocks that far apart, alternating, allow a full burst at
  each switch. Keep the servers' clocks synchronised.
- **Every process must use the same definition.** Two deploys with different
  `limit`, `per` or `burst` under the same `name` read the same key with
  different rates. Rename the limit when its rate changes a lot.
- **`remaining` counts requests of cost 1.** A bucket with 2 remaining denies
  a `consume(params, 3)` and counts nothing.
- **A cost above the burst is refused, not queued.** No bucket ever holds more
  than `burst`, so it could never be allowed.

Idempotency:

- **The lease is not renewed yet.** A run holds its key for `lease`
  milliseconds (default 10 s); work that runs longer loses it, and a repeat
  that arrives after that **runs the work a second time**. The first run then
  fails with `LEASE_LOST` and stores nothing, and the second one's result is
  what replays. Set `lease` above the longest the work can take. A heartbeat
  that renews it is on the [roadmap](docs/roadmap.md).
- **`ttl` is seconds; `lease` is milliseconds.** `ttl` follows Redis's
  `EXPIRE` and `@nxgt/redis`'s `defineCache`; `lease` follows every other
  duration in this package. `ttl: 86_400` is a day; `lease: 86_400` is under
  a minute and a half.
- **A thrown error is not stored.** The key is given back and the next repeat
  runs the work again — right for a failure worth retrying (a timeout, a
  database that was down). A failure the client must get back unchanged is a
  result: return it as a union member of the schema.
- **The schema has to read what was stored for as long as `ttl`.** A replay
  parses the stored result with **today's** schema. A deploy that adds a
  required field makes every result stored before it `INVALID` until it
  expires — and `INVALID` on replay does **not** run the work again, since
  that would repeat what it did. Add fields as optional or with a
  `.default()`, or rename the operation.
- **A result must survive JSON, and the schema must accept its own output.**
  It is stored as JSON and parsed again on each replay. A `z.date()`, a
  `bigint`, or a transform that does not accept what it produced is refused
  on the first run, before anything is stored.
- **Fingerprint the raw body, not a re-serialised object.** `JSON.stringify`
  of a parsed body depends on key order and on what the parser dropped; two
  identical requests could then disagree, and two different ones agree. Hash
  what arrived: `await request.text()`, or the bytes.
- **Scope the key.** A client's `Idempotency-Key` is only unique to that
  client: key on the user or the tenant as well, or two users choosing the
  same key would get each other's result. The fingerprint catches most of
  that, but only when both send one.
- **If storing the result fails, the work has still happened.** A connection
  lost between `work` and the store leaves the key running until its lease
  lapses, and the error is Redis's. A repeat within the lease gets
  `IN_PROGRESS`; after it, the work runs again.
- **A running key cannot be waited for yet.** A repeat during the first run
  gets `IN_PROGRESS` and its `retryAfter`; waiting for the result instead is
  on the roadmap.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/rate-limits.md](docs/guide/rate-limits.md) — GCRA, choosing a
  rate, and the HTTP recipe.
- [docs/guide/idempotency.md](docs/guide/idempotency.md) — the storage, the
  fingerprint, `ttl` and `lease`, and the HTTP recipe.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT

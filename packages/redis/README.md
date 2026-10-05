# @nxgt/redis

Redis on **Bun's own client** — no third-party driver. One connection shared
per URI, caches and channels described once and typed from their schema, and a
lock that is safe to release — and rate limits and idempotent operations, each one atomic script timed by the Redis server's clock.

```ts
import { defineRedis, openRedis } from '@nxgt/redis';
import * as caches from './caches';       // every `defineCache` of the app
import * as channels from './channels';   // every `defineChannel`

export const redis = await openRedis(
	defineRedis({
		uri: process.env.REDIS_URL!,
		prefix: 'myapp:prod',
		caches,
		channels,
	}),
);

const user = await redis.cache.users.remember(id, () => loadUser(id));
await redis.channels.created.publish(user);
await redis.lock('import', () => importEverything());
```

`redis.cache.users` is the bound cache `bindCache(client, users)` gives, and
`redis.channels.created` the same for a channel — each under the key its
definition is exported by, with the deployment's prefix already in front of
everything it writes. Nothing else has to be passed around: no client, no
`bindCache` at a call site, no prefix spelled by hand.

`redis.instances.default.client` is Bun's `RedisClient`, untouched: everything
this package does not wrap is still there. The pieces `defineRedis` and
`openRedis` are made of — `connectRedis`, `defineCache` and `bindCache`,
`withLock`, `defineChannel` — are exported too, and are what the sections
below describe.

> **0.x, on Bun's `RedisClient`.** The API is still settling.

## Install

```sh
bun add @nxgt/redis zod typescript @types/bun
```

- **Bun 1.4 or later, and Bun only.** `RedisClient` is built into Bun, which
  is why there is no client dependency to install — and why this package does
  not run on Node. It uses `duplicate()`, `subscribe`/`unsubscribe` and the
  variadic `set` overload, all of which Bun 1.4 has.
- `zod` `>=4.6.5 <5`: required peer. A cache and a channel are described by a
  schema, and nothing is stored or published unchecked.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package pins.
- `@types/bun`: required to typecheck. The shipped declarations name Bun's own
  `RedisClient` and `RedisOptions`, so without Bun's types the first `tsc`
  fails with `Cannot find module 'bun'`.
- Tested against Redis 7.4.

## The pieces underneath

```ts
import { z } from 'zod';
import { bindCache, connectRedis, defineCache, withLock } from '@nxgt/redis';

const userCache = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 300,                                   // seconds
	schema: z.object({ id: z.string(), email: z.string() }),
});

const redis = await connectRedis(process.env.REDIS_URL!);
const users = bindCache(redis.client, userCache);

const user = await users.remember(id, () => loadUser(id));

await withLock(redis.client, 'invoices:nightly', sendInvoices, {
	ttl: 60_000,                                // milliseconds — see Traps
	wait: 5_000,
});
```

`redis.client` is Bun's `RedisClient`, untouched.

## Rate limits and idempotency

Two guards on any Bun `RedisClient` — the `redis.instances.default.client` of
a wiring, or one you opened — each described once, keyed by a typed function,
and checked by an atomic script on the server, timed by the **Redis server's
clock**, so every process sharing the Redis agrees. Their error is
`GuardError`, with its own codes (see Errors).

**A rate limit** — so many requests per window, per caller:

```ts
import { bindRateLimit, defineRateLimit, GuardError } from '@nxgt/redis';

export const exportLimit = defineRateLimit({
	name: 'export',
	key: (p: { org: string; user: string }) => `${p.org}/${p.user}`,
	limit: 10,          // ten requests…
	per: 60_000,        // …a minute, in MILLISECONDS — see Traps
	burst: 20,          // and up to twenty at once from a full bucket
});

const exports = bindRateLimit(client, exportLimit);   // `client`: a Bun RedisClient

async function startExport(who: { org: string; user: string }): Promise<Response> {
	try {
		await exports.enforce(who);   // consume() answers { allowed, retryAfter, … } instead
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
```

It is **GCRA**, one Lua script over one key, in exact integers; a denial and a
`peek` write nothing, and an idle limit leaves no key. The
[rate limits guide](docs/guide/guard/rate-limits.md) has the algorithm, choosing
`burst`, costs, and the `RateLimit-*` headers.

**An idempotent operation** — run once per key, and replay the result to every
repeat:

```ts
import { z } from 'zod';
import { bindIdempotency, defineIdempotency, GuardError } from '@nxgt/redis';

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

const orders = bindIdempotency(client, createOrder);

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
gets `IN_PROGRESS` if it is still running. **A thrown error is never stored**,
so a failure the client must get back on every repeat is returned as a union
member of the schema — see
[a failure worth replaying](docs/guide/guard/idempotency.md#a-failure-worth-replaying-is-a-result).
The [idempotency guide](docs/guide/guard/idempotency.md) has the fingerprint,
the lease and its renewals, `wait`, the storage, and the HTTP recipe in full;
[testing](docs/guide/guard/testing.md) shows specs for both.

| Function | |
| --- | --- |
| `defineRateLimit({ name, key, limit, per, burst? })` | describes a rate limit; talks to nothing. Frozen. A definition that could never work is a bare `TypeError`, normally at import |
| `bindRateLimit(client, definition)` | binds it to a `RedisClient`: `keyFor`, `consume(params, cost = 1)`, `enforce` (throws `RATE_LIMITED`), `peek` (counts nothing; `cost` may be `0`) and `reset`. Every duration is a delay in milliseconds, rounded up — never a date |
| `defineIdempotency({ name, key, ttl, lease?, schema })` | describes an idempotent operation; talks to nothing. Frozen. `ttl` in **seconds**, `lease` in **milliseconds** (default `10_000`) |
| `bindIdempotency(client, definition)` | binds it to a `RedisClient`: `keyFor`, `run(params, work, { fingerprint?, wait? })` resolving to `{ value, replayed }`, and `forget(params)` |

The types are `RateLimitDefinition`, `BoundRateLimit`, `LimitResult`,
`IdempotencyDefinition`, `BoundIdempotency`, `Idempotent` and `RunOptions`.

## What it does not do

- **No `multi`/`exec`.** Bun's client has none, and nothing here needs one:
  the lock is `SET NX PX`, one command, and its release is one script.
- **It does not retry for you.** Bun's client reconnects; a command that fails
  fails, and the error is Redis's own.
- **It is not a queue.** Pub/sub is fire-and-forget — see Traps.
- **It listens to no signal.** Closing on shutdown is yours, with `close()` or
  `closeRedis()`.

## API

### Wiring

```ts
// src/redis/caches.ts
import { defineCache } from '@nxgt/redis';
import { z } from 'zod';

export const users = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 300,                              // seconds
	schema: z.object({ id: z.string(), email: z.string() }),
});
```

Every export that is a `defineCache` becomes a key on `redis.cache`, every
`defineChannel` a key on `redis.channels`, under the name it is **exported** by;
a schema, a type or a constant in the same file is left where it is. One
definition exported under two keys is refused: both would write the same keys.
`redis.cache` and `redis.channels` are two scopes, not one client with names on
it: nothing falls through to the driver, and a key wired nowhere is plainly
`undefined`.

| Key of `defineRedis` | Default | |
| --- | --- | --- |
| `uri` | — | Where to connect. One of `uri` and `client`, never both |
| `client` | — | A client the application opened. **Never closed** by `openRedis` |
| `clientOptions` | `{}` | Bun's `RedisOptions`, passed with `uri`. Refused beside `client` |
| `prefix` | — | Put in front of every key, channel and lock this instance writes |
| `caches`, `channels` | — | `import * as caches from './caches'`, as it is |
| `instances` | — | Several Redis instances, each taking the keys above. Written *instead* of them |

`defineRedis` **connects to nothing and reads no environment variable**; what
is wrong with the wiring throws there, where the application starts. A single
instance is named `default`; with several, `redis.cache` and `redis.channels`
are `never` and `redis.instances.<name>` says which, as does `{ on: 'cache' }`
on `redis.lock`.

```ts
await redis.lock('import', work, { on: 'cache' });   // lock:myapp:import
const health = await redis.ping();                    // { default: { ok: true, latencyMs } }
await redis.close();                                  // or `await using redis = await openRedis(…)`
```

`close()` closes every subscription the wiring started and then the clients it
opened, in that order; a `client` the configuration handed in is left alone.
`RedisOf<typeof config>` writes the type of the result from the configuration.
The wiring raises a bare `TypeError` naming the instance and what to do — all
at wiring time — and what a call throws is the `RedisError` of the next
sections. Every message is in
[docs/troubleshooting.md](docs/troubleshooting.md#wiring-defineredis-and-openredis).

Each of these is a `@ts-expect-error` case in the type tests: `redis.cache.nope`;
a cache read or written with the wrong params or a field its schema does not
have; a payload a channel's schema does not describe; `redis.cache` on several
instances, and `{ on: 'nowhere' }` on `lock`; a cache read off an instance that
wires only channels; an option the configuration does not have.

### Connection

```ts
const redis = await connectRedis(url, { autoReconnect: false });
const health = await redis.ping();          // never throws
await redis.close();                        // or `await using redis = …`
```

`connectRedis(uri, options?)` shares one `RedisClient` per URI, connected once
even when the calls race. `options` is **Bun's own `RedisOptions`** —
`autoReconnect`, `connectionTimeout`, `maxRetries` and the rest — kept as a
copy, so your object is yours to change afterwards. A connect that fails is
forgotten, so calling again retries it.

| `RedisConnection` | |
| --- | --- |
| `client: RedisClient` | Bun's own, shared |
| `ping(options?)` | `{ ok: true, latencyMs }` or `{ ok: false, error }`, within `timeoutMs` (default 2 s). Never throws |
| `close()` | idempotent. The client closes with the last holder |

`closeRedis()` closes every client, whoever still holds one — the end of a
process, or of a test file.

| Type | |
| --- | --- |
| `RedisConnection` | what `connectRedis` gives back; also `AsyncDisposable` |
| `PingResult` | `{ ok: true, latencyMs: number } \| { ok: false, error: unknown }` |

### Cache

```ts
const seatCache = defineCache({
	name: 'seat',
	key: (p: { org: string; user: string }) => `${p.org}/${p.user}`,
	ttl: 60,                                   // seconds
	schema: z.object({ taken: z.number() }),
});

const seats = bindCache(redis.client, seatCache);
await seats.set({ org: 'acme', user: 'u1' }, { taken: 3 });
```

`defineCache({ name, key, ttl, schema })` describes a cache; it talks to
nothing. The key is a **function**, so nothing is spelled by hand at a call
site and a renamed parameter is a compile error. A stored key is
`` `<name>:<key(params)>` ``. `ttl` is **seconds**, Redis's own unit for `EX`.

| `BoundCache<P, T, I>` | |
| --- | --- |
| `keyFor(params)` | the key it would use, for a caller that needs the string |
| `get(params)` | the value, or `undefined` — a miss, an expiry, or a stale shape |
| `set(params, value, { ttl })` | the value as the schema **accepts** it — a `.default()` field may be left out — checked, then stored as the schema gives it back |
| `remember(params, load, { ttl })` | the value if it is there, otherwise what `load` gives (as the schema accepts it), stored — and given back **as it was stored**, defaults filled |
| `delete(params)` | `true` when something was there |

| Type | |
| --- | --- |
| `CacheDefinition<P, S>` | what `defineCache` takes and gives back |
| `BoundCache<P, T, I>` | what `bindCache` gives back: `T` read, `I` written (`I` defaults to `T`) |
| `ParamsOf<D>` | the params a definition's `key` takes, for a caller writing its own helper |
| `ValueOf<D>` | what a definition's schema gives back — what a read returns |
| `InputOf<D>` | what a definition's schema accepts — what `set` and a loader take |

### Locks

```ts
try {
	await withLock(redis.client, 'invoices:nightly', sendInvoices, {
		ttl: 60_000,       // milliseconds the lock is held
		wait: 5_000,       // milliseconds to keep trying to take it
	});
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') {
		return;            // another worker has it; nothing ran, so move on
	}
	if (error instanceof RedisError && error.code === 'LOCK_LOST') {
		alert('nightly invoices overran their lock');   // it may have doubled
		return;
	}
	throw error;           // the work's own failure
}
```

`withLock(client, key, work, options?)` takes `` `lock:<key>` `` with
`SET NX PX`, runs `work`, and releases it with a script that **checks the
token first** — so a run that overran its `ttl` can never free the lock
somebody else has since taken.

| `LockOptions` | |
| --- | --- |
| `ttl` | milliseconds the lock is held before Redis drops it (default `30_000`) |
| `wait` | milliseconds to keep trying to take it (default `0` — refuse at once) |
| `retryDelay` | milliseconds between tries (default `50`) |

### Pub/sub

```ts
const userCreated = defineChannel({ name: 'user.created', schema: userSchema });

await publish(redis.client, userCreated, user);

await using running = await subscribe(
	redis.client,
	userCreated,
	(user) => console.log('welcome', user.email),   // typed by the schema
	{ onError: (error, raw) => log.warn({ raw }, error) },
);
```

| | |
| --- | --- |
| `publish(client, channel, payload)` | checks the payload, then publishes. Gives the number of subscribers Redis handed it to |
| `subscribe(client, channel, handler, options?)` | listens, each message parsed by the schema. Gives a `Subscription` |
| `SubscribeOptions.onError` | `(error: unknown, raw: string) => void`, called **instead of** the handler for a message that does not parse or a handler that throws. Defaults to `console.error` |
| `Subscription` | `{ channel, close() }`, also `AsyncDisposable`. `close()` is idempotent |

`subscribe` **duplicates** the client, because a subscriber connection can run
most other commands no longer — Redis's own rule. `close()` gives that copy
back; the client passed in is untouched and is still the one to `publish`
with. Each subscription is one more connection.

## Errors

`RedisError` is what this package throws once it is talking to Redis, with a
`code` and the `key` or channel it happened on — never a value, and never a
URI.

```ts
if (error instanceof RedisError && error.code === 'LOCK_HELD') { … }
```

| `RedisErrorCode` | |
| --- | --- |
| `LOCK_HELD` | `wait` ran out and somebody else still holds it |
| `LOCK_LOST` | the work finished, but the lock had already expired |
| `INVALID` | a value does not match the schema it is stored or published under |
| `CONNECTION` | `closeRedis()` closed every client while this `connectRedis` was still connecting |
| `PING_TIMEOUT` | `ping` gave up waiting. **Returned** on `{ ok: false, error }`, never thrown |

`key` is `''` for those last two — they are about the connection, not a key —
and it is never the URI, which may carry a password.

**Three `TypeError`s come earlier, at definition time**, and normally at
import: `defineCache` refuses an empty `name` and a `ttl` that is not a finite
number above zero, and `defineChannel` refuses an empty `name`.
`connectRedis` throws a `TypeError` when a URI is already connected with other
options. Redis's own failures come back as they are, from Bun's client.

`GuardError` is what the rate limits and idempotency throw, with a `code` and
the `definition` it happened on — its `name`, never the key it built nor the
params, which came from a request. It is its own class, not a `RedisError`.

| `GuardErrorCode` | |
| --- | --- |
| `RATE_LIMITED` | `enforce` found the limit spent. Carries `retryAfter`, in milliseconds |
| `COST` | a cost that is not a whole number from 1 (0 for `peek`) to the burst |
| `IN_PROGRESS` | `run` found the key still running — at once, or when its `wait` ran out. Carries `retryAfter`: milliseconds until that run's lease lapses **unless renewed**, which a live run does |
| `MISMATCH` | `run` found the key first used with a different fingerprint — or with one where this call has none, or the reverse |
| `INVALID` | what `work` returned does not match the schema — not stored, key given back; or what was stored no longer does — kept, and `work` **not** run again; or the record at the key is not one `run` wrote |
| `LEASE_LOST` | the key was taken from the run before it finished — `forget`, or its lease lapsed because no renewal reached Redis for a whole lease — so a repeat may have run `work` too. Its result was not stored |

An `INVALID` message lists zod's issue **codes** only — never zod's messages
nor the paths, which can quote what the value held. `defineRateLimit` and
`defineIdempotency` (and their `bind*`, for a definition written by hand)
refuse a definition that could never work with a `TypeError`, and `run` a
`fingerprint` or a `wait` of the wrong kind. Every message is in
[troubleshooting](docs/troubleshooting.md#rate-limits-and-idempotency).

## What does not compile

Each is a `@ts-expect-error` case in `test/types/redis.ts`.

- A cache read or written with the wrong key parameters, or the wrong value.
- A `key` that gives something other than a string, or a `ttl` that is not a
  number.
- A cache or a channel with no schema, a channel with no name.
- A cache definition passed to `publish`, or a channel definition to
  `bindCache` — they are otherwise structurally alike.
- A cache definition passed to `bindIdempotency`, or an idempotency to
  `bindCache`: both write `<name>:<key>`, as different Redis types, which
  would be `WRONGTYPE`. A rate limit, a cache, a channel and an idempotency
  are each refused by every other (`test/types/idempotency.ts`).
- A published payload the channel's schema does not describe, and a field a
  subscriber's handler reads that is not on it.
- An option `withLock` does not have.
- The guards' own refusals, in `test/types/guard.ts` and `test/types/idempotency.ts`: a call with the wrong params or a `cost` that is a string, a definition without `per`, `limit`, `key`, `ttl` or `schema`, a `work` that returns what the schema does not accept, a `fingerprint` that is a number, a `GuardErrorCode` it does not have, and a rate limit handed to `bindIdempotency` or the reverse.

## Traps

- **A write is typed by what the schema accepts.** `set` and a `remember`
  loader take `z.input`, so a `.default()` field may be left out. Where a
  field's input type is `unknown` — `z.coerce.number()` — the compiler accepts
  any value there, though the key is still required; a whole `z.preprocess`
  schema accepts anything. There the schema refuses a wrong value at run time.
  A value read back (`z.output`) is not always a valid input: where a
  transform changes a type, its output passed to `set`, or returned by a
  loader, does not compile — see
  [troubleshooting](docs/troubleshooting.md#types).
- **`ttl` is seconds for a cache and milliseconds for a lock.** A cache's is
  Redis's `EX`; a lock's is its `PX`, because a lock's deadline is usually
  well under a second's resolution.
- **A lock's `ttl` is a deadline for the work, not a hint.** Whatever is still
  running when it passes is no longer protected, and `withLock` then throws
  `LOCK_LOST` **after** the work returned — the work may have run beside
  another holder's, so its result is not safe to trust. Size the `ttl` above
  the slowest run you accept.
- **`LOCK_HELD` is not a failure of the work.** Nothing ran. A scheduled job
  that catches it and moves on is usually right; one that retries needs
  `wait`.
- **A release that fails replaces the work's result.** If the work succeeds
  but the release round trip throws — a connection blip — that error is what
  you see, and the work's value is lost. The lock then stays until its `ttl`.
- **A stale shape is a miss, not an error.** A stored value that no longer
  matches the schema — an older deploy's — is deleted and read as `undefined`,
  and so is anything that is not this package's JSON. A value being *written*
  that does not match throws `INVALID` instead: that is a bug, not a leftover.
  `remember` writes through `set`, so a loader returning a refused value
  throws **after** the expensive work has already been paid for.
- **`remember` does not hold a lock.** Two callers missing at once both call
  `load`, and the last one's value is what stays. Wrap it in `withLock` where
  loading is expensive or must happen once.
- **Pub/sub is fire-and-forget.** `publish` gives the number of subscribers
  Redis handed the message to — not a delivery guarantee. A subscriber that is
  not connected at that instant never sees it, and nothing is replayed. Use a
  stream or a queue where a message must not be lost.
- **A handler's error never reaches your caller.** It goes to `onError`, which
  writes to `console.error` unless you pass one — a listener's throw has
  nowhere else to go, and Bun ends the process on an unhandled rejection. An
  `onError` that throws is caught too, and reported to `console.error`.
- **`connectionTimeout` does not bound a connect to a port nothing listens
  on.** Measured: Bun reconnects by default and rejects after about **31
  seconds**. Pass `autoReconnect: false` where a fast failure matters, such as
  a startup health check:

  ```ts
  await connectRedis(url, { autoReconnect: false });
  ```

- **…but then every other call for that URI must pass it too.** The options
  must match at each call, or `connectRedis` throws
  `TypeError: this URI is already connected with other options` — and the
  message withholds the URI, because it may carry a password. A startup check
  with `autoReconnect: false` and an application `connectRedis(url)` is the
  usual way to hit this: give the check its own URI, close it before the
  application connects, or pass the same options everywhere.
- **The prefix is inside `lock:`** — `redis.lock('import')` under
  `prefix: 'myapp'` writes `lock:myapp:import`, not `myapp:lock:import`,
  because `withLock` writes `lock:${key}` itself. A key you read by hand has to
  be spelled that way.
- **A subscription costs a connection.** Close it, or let `redis.close()` do
  it; one that outlives the wiring is a socket nobody gives back.
- **A client the configuration handed in is never closed**, `await using`
  included. Close it where it was opened.
- **Two instances on one URI are one client**, so the second one's
  `clientOptions` must match the first's, or `connectRedis` refuses them.
- **`close()` on one connection is not `closeRedis()`.** The first gives back
  one holder; the second takes every client away from everybody.
- **A connect that `closeRedis()` interrupts rejects, with `CONNECTION`.** At
  shutdown a request still connecting fails rather than get a closed client;
  connecting again opens a fresh one, since the failure was the race and not
  the URI.
- **Rate limits.**

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
    [the key](docs/guide/guard/rate-limits.md#describing-a-limit).
  - **A cost beyond what is left is denied and counts nothing; one beyond the
    burst rejects with `COST`.** Check `cost <= (exportLimit.burst ?? exportLimit.limit)`
    where a request sets it — [more](docs/troubleshooting.md#consume-on-login-a-cost-must-be-a-whole-number-from-1-to-the-burst-of-5).

- **Idempotency.**

  - **Synchronous work can lose the lease**: the renewal timer cannot fire
    while the event loop is blocked, so after a whole `lease` a repeat runs
    `work` again and the first rejects with `LEASE_LOST`. `await Bun.sleep(0)`
    between chunks, or a `Worker` — [the lease](docs/guide/guard/idempotency.md#the-lease).
  - **`ttl` is seconds; `lease` is milliseconds.** `ttl: 86_400` is a day;
    `lease: 86_400` is under a minute and a half — [choosing them](docs/guide/guard/idempotency.md#choosing-ttl-and-lease).
  - **A thrown error is not stored**, so the next repeat runs again. Return a
    failure that must replay as a union member of the schema — [example](docs/guide/guard/idempotency.md#a-failure-worth-replaying-is-a-result).
  - **A replay parses with today's schema**, and a stored result it refuses is
    `INVALID`, not run again. Add fields with `.optional()` or `.default()` —
    [changing the schema](docs/guide/guard/idempotency.md#changing-the-schema).
  - **A result must survive JSON**: a `z.date()` or a `bigint` is refused on
    the first run. `z.iso.datetime()` and a string — [more](docs/troubleshooting.md#run-on-orderscreate-the-result-does-not-match-the-schema-once-stored-as-json-so-it-was-not-stored-invalid_type).
  - **Fingerprint the raw body**, not `JSON.stringify` of a parsed one, or
    identical requests can mismatch. `{ fingerprint: await request.text() }` —
    [the fingerprint](docs/guide/guard/idempotency.md#the-fingerprint).
  - **Scope the key**: an `Idempotency-Key` is unique only to its client.
    `` key: (p) => `${p.user}/${p.key}` `` —
    [describing an operation](docs/guide/guard/idempotency.md#describing-an-operation).
  - **A Redis error after `work` means the work happened**, and the key may stay
    running until its lease lapses, then runs again. Make `work` safe to repeat
    where it can be — [the same request ran twice](docs/troubleshooting.md#the-same-request-ran-twice).
  - **`wait` holds the request open** while it polls. Keep it under your HTTP
    timeout: `wait: 2_000` — [waiting](docs/guide/guard/idempotency.md#waiting-for-a-running-key).

## Documentation

- [docs/README.md](docs/README.md) — the guide index: connections, caches,
  locks and pub/sub, each with its options and a worked example, and the
  wiring pages for `defineRedis` and `openRedis`.
- [Wiring guides](docs/guide/wiring/configuration.md) — the configuration and
  its prefix, `redis.cache`, `redis.channels`, `redis.lock` and `redis.ping`,
  several Redis instances, and who closes what.
- [Rate limit and idempotency guides](docs/guide/guard/rate-limits.md) — GCRA,
  choosing a rate and the HTTP recipe; [idempotency](docs/guide/guard/idempotency.md),
  the storage, the fingerprint, `ttl` and `lease`;
  [testing](docs/guide/guard/testing.md) against a real Redis.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT

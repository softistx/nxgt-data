# Troubleshooting

This package throws one error of its own, `RedisError`, with a `code` of
`LOCK_HELD`, `LOCK_LOST`, `INVALID`, `CONNECTION` or `PING_TIMEOUT`, and the
key or channel it happened on as `key` — never the value. `CONNECTION` and
`PING_TIMEOUT` are about the client rather than one key, so their `key` is
the empty string; it is never the URI, because a connection string holds the
password. Everything else comes from Bun's `RedisClient` as it is.

`defineCache` and `defineChannel` check their arguments before anything
connects, and a URI already connected with other options is a plain
`TypeError` still: those are mistakes in the code, not something a running
application can handle.

- **Install and import**
  - [`Cannot find package 'bun'`](#cannot-find-package-bun)
  - [`Cannot find module 'bun' or its corresponding type declarations.`](#cannot-find-module-bun-or-its-corresponding-type-declarations)
- **Types**
  - [`Argument of type 'Date' is not assignable to parameter of type 'string'.`](#argument-of-type-date-is-not-assignable-to-parameter-of-type-string)
- **Configuration**
  - [`defineCache: a cache needs a name, for its keys`](#definecache-a-cache-needs-a-name-for-its-keys)
  - [`defineChannel: a channel needs a name`](#definechannel-a-channel-needs-a-name)
  - [`defineCache: "user" has a ttl of 0; it is a number of seconds, and must be above zero`](#definecache-user-has-a-ttl-of-0-it-is-a-number-of-seconds-and-must-be-above-zero)
  - [`connectRedis: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`](#connectredis-this-uri-is-already-connected-with-other-options-pass-the-same-options-everywhere-or-close-the-first-connection)
  - [`connectRedis: every client was closed while this one was connecting.`](#connectredis-every-client-was-closed-while-this-one-was-connecting)
  - [A connect to a port nothing listens on takes about 31 seconds](#a-connect-to-a-port-nothing-listens-on-takes-about-31-seconds)
  - [`ping: no answer in 2000ms`](#ping-no-answer-in-2000ms)
- **Runtime**
  - [``The lock "jobs:nightly" is held by somebody else, and this call did not wait for it — pass `wait` ``](#the-lock-jobsnightly-is-held-by-somebody-else-and-this-call-did-not-wait-for-it--pass-wait-)
  - [`The lock "jobs:nightly" is held by somebody else, and 5000ms was not long enough to wait for it`](#the-lock-jobsnightly-is-held-by-somebody-else-and-5000ms-was-not-long-enough-to-wait-for-it)
  - [`The lock "jobs:nightly" expired before its work finished: it ran longer than the 30000ms ttl, so it may have run beside another holder`](#the-lock-jobsnightly-expired-before-its-work-finished-it-ran-longer-than-the-30000ms-ttl-so-it-may-have-run-beside-another-holder)
  - [`This value does not match the schema "user" stores:`](#this-value-does-not-match-the-schema-user-stores)
  - [`This message does not match the schema "orders" carries:`](#this-message-does-not-match-the-schema-orders-carries)
  - [`A message on "orders" does not match its schema:`](#a-message-on-orders-does-not-match-its-schema)
  - [A published message never arrives](#a-published-message-never-arrives)

## Install and import

### `Cannot find package 'bun'`

**When:** importing `@nxgt/redis` under Node — the full line names the file it
was imported from.
**Why:** the client is Bun's own `RedisClient`, which is why there is no
driver to install and why this package does not run on Node. Measured on Node
22.
**Fix:**

```sh
bun run ./src/index.ts   # Bun 1.4 or later
```

### `Cannot find module 'bun' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/redis`.
**Why:** the shipped declarations import `RedisClient` and `RedisOptions`
from `bun`, so your project needs Bun's types. They are not a dependency of
this package.
**Fix:**

```sh
bun add -d @types/bun
```

`zod` `>=4.6.5 <5` is a required peer for the same kind of reason: a cache
and a channel are described by your schema, so it has to be the copy this
package parses with.

## Types

### `Argument of type 'Date' is not assignable to parameter of type 'string'.`

**When:** typechecking, after upgrading to 0.3.0, on a cache whose schema
transforms one type into another — here `z.string().transform((s) => new
Date(s))`. It is `TS2345` on `set`, and it comes in two other forms:

```
// a `remember` loader that returns the output — TS2322
Type 'Promise<Date>' is not assignable to type 'string | Promise<string>'.
  Type 'Promise<Date>' is not assignable to type 'Promise<string>'.
    Type 'Date' is not assignable to type 'string'.

// a two-argument `BoundCache<P, ValueOf<D>>` annotation — TS2322
Type 'BoundCache<string, Date, string>' is not assignable to type 'BoundCache<string, Date, Date>'.
  Type 'string' is not assignable to type 'Date'.
```

**Why:** since 0.3.0 `set` and a loader take what the schema **accepts** —
`z.input`, the string — while `get` and `remember` return what it gives back,
`z.output`, the `Date`. A value read back is not a valid input when the
transform changed its type. Where input and output overlap, as with
`z.string().transform((s) => (s === '' ? null : s))`, the two-argument
annotation still compiles, and only a read-back value passed to `set` fails,
as `Argument of type 'string | null' is not assignable to parameter of type
'string'.`
**Fix:** pass the input, and name it with `InputOf` where you annotate:

```ts
import type { BoundCache, InputOf, ParamsOf, ValueOf } from '@nxgt/redis';

await seen.set('u1', raw);                            // the string, not the Date
await seen.remember('u1', () => loadRaw('u1'));       // the loader returns the input too

type Seen = BoundCache<
	ParamsOf<typeof seenCache>,
	ValueOf<typeof seenCache>,
	InputOf<typeof seenCache>
>;
```

## Configuration

### `defineCache: a cache needs a name, for its keys`

**When:** at `defineCache`, with an empty `name`.
**Why:** the name is the prefix of every key this cache writes
(`<name>:<key>`), so an empty one would scatter values across the keyspace.
**Fix:**

```ts
export const users = defineCache({ name: 'user', key: (id: string) => id, ttl: 300, schema });
```

### `defineChannel: a channel needs a name`

**When:** at `defineChannel`, with an empty `name` — usually a name read from
the environment that was not set.
**Why:** the name **is** the Redis channel `publish` and `subscribe` talk on,
and there is no channel to talk on when it is empty. A plain `TypeError`:
nothing has connected yet.
**Fix:**

```ts
import { defineChannel } from '@nxgt/redis';
import { z } from 'zod';

export const orders = defineChannel({
	name: 'orders',
	schema: z.object({ id: z.string(), total: z.number() }),
});
```

A channel takes no `ttl` — a message is not kept, so there is nothing to
expire, and the `ttl?: never` in its type is what stops a cache definition
from being published on by mistake.

### `defineCache: "user" has a ttl of 0; it is a number of seconds, and must be above zero`

**When:** at `defineCache`.
**Why:** a cache's `ttl` is Redis's `EX`, in **seconds**. A lock's is its
`PX`, in **milliseconds**, because a lock's deadline is usually well under a
second's resolution — mixing the two up is what this check catches.
**Fix:**

```ts
defineCache({ name: 'user', key, ttl: 300, schema });       // 5 minutes
await withLock(client, 'invoices:nightly', work, { ttl: 60_000 }); // 60 seconds
```

### `connectRedis: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`

**When:** a second `connectRedis` for the same URI with different options.
**Why:** one client is shared per URI, and the options are compared by value.
The URI is deliberately left out of the message: it may carry a password.
The usual way in is a start-up health check with `autoReconnect: false` beside
an application `connectRedis(url)`.
**Fix:**

```ts
// the same options everywhere…
await connectRedis(url, { autoReconnect: false });
// …or close the check's connection before the application connects
```

### `connectRedis: every client was closed while this one was connecting.`

**When:** at shutdown, when `closeRedis()` ran while something was still
connecting.
**Why:** the shared client being waited for is gone, so the connect rejects
rather than handing back a dead one. A `RedisError` with
`code: 'CONNECTION'` since 0.2.0 — it was a bare `Error` before — and its
`key` is empty: it is about the client, and the URI is never printed.
Redis's own refusal to connect is Bun's error, and reaches you unchanged.
**Fix:**

```ts
await connection.close(); // give back one holder; closeRedis() takes every client away
```

It is the one failure worth retrying — the connect raced the shutdown, the
URI is fine — so a worker that reconnects can tell it apart:

```ts
import { RedisError } from '@nxgt/redis';

try {
	return await connectRedis(url);
} catch (error) {
	if (error instanceof RedisError && error.code === 'CONNECTION') {
		return await connectRedis(url); // a fresh client, once the close is done
	}
	throw error;
}
```

### A connect to a port nothing listens on takes about 31 seconds

**When:** `connectRedis` against a Redis that is not there, with
`connectionTimeout` set. No error for half a minute.
**Why:** measured on Bun 1.4: the client reconnects by default, and
`connectionTimeout` does not bound the whole attempt — the rejection comes
after roughly 31 seconds.
**Fix:**

```ts
await connectRedis(url, { autoReconnect: false }); // fails fast, for a health check
```

### `ping: no answer in 2000ms`

**When:** `connection.ping()`, when `PING` did not come back within the
timeout — 2000 ms by default, or the `timeoutMs` passed. It is **not thrown**:
a health check reports rather than fails, so the message arrives as the
`error` of `{ ok: false, error }`, usually noticed in a log line or a `/health`
body.
**Why:** the client is connected but the round trip did not finish in time —
Redis is busy on a long command, the link is slow, or the server went away
without the socket noticing yet. Since 0.2.0 it is a `RedisError` with
`code: 'PING_TIMEOUT'` and an empty `key`, so the `error` a health check
reports carries a code to log rather than a sentence to match.
**Fix:**

```ts
const health = await connection.ping({ timeoutMs: 500 });
if (!health.ok) return serviceUnavailable(); // `health.error` is what to log
return { ok: true, latencyMs: health.latencyMs };
```

`PingResult` is a union: `ok: true` carries `latencyMs`, `ok: false` carries
`error`. A timeout leaves the connection usable; it says nothing was answered
in time, not that the client is gone.

## Runtime

### ``The lock "jobs:nightly" is held by somebody else, and this call did not wait for it — pass `wait` ``

**When:** `withLock` with no `wait` (the default), while another holder has
the lock.
**Why:** a `RedisError` with `code: 'LOCK_HELD'`. **Nothing ran** — this is
not a failure of the work.
**Fix:**

```ts
try {
	await withLock(client, 'jobs:nightly', work);
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') return; // someone else has it
	throw error;
}
```

A scheduled job that catches it and moves on is usually right; one that must
run takes `wait`.

### `The lock "jobs:nightly" is held by somebody else, and 5000ms was not long enough to wait for it`

**When:** `withLock` with `wait`, when the lock was still held when the wait
ran out.
**Why:** the same `LOCK_HELD`, after retrying every `retryDelay` until the
deadline. Nothing ran.
**Fix:**

```ts
await withLock(client, 'jobs:nightly', work, { ttl: 60_000, wait: 30_000 });
```

### `The lock "jobs:nightly" expired before its work finished: it ran longer than the 30000ms ttl, so it may have run beside another holder`

**When:** `withLock`, **after** the work returned: the release found the lock
was no longer this call's.
**Why:** the `ttl` is a deadline for the work, not a hint. Whatever is still
running past it is no longer protected, so the work may have run beside
another holder's and its result is not safe to trust. `code: 'LOCK_LOST'`.
**Fix:**

```ts
await withLock(client, 'jobs:nightly', work, { ttl: 300_000 }); // above the slowest run
```

A release that fails for another reason — a connection blip — replaces the
work's result with that error too, and the lock then stays until its `ttl`.

### `This value does not match the schema "user" stores:`

**When:** `set`, or `remember` when the loader returns the value — after the
expensive work has already been paid for. The schema's issues follow the
colon.
**Why:** a `RedisError` with `code: 'INVALID'`. A value being **written**
that does not match is a bug, not a leftover, so it throws.
**Fix:** check at the source, and hand the cache the value as it came —
the input — since the cache parses it again on the way in:

```ts
import type { z } from 'zod';

const user = await users.remember(id, async () => {
	const raw = await loadUser(id);
	const checked = userSchema.safeParse(raw);
	if (!checked.success) throw checked.error; // names the source, not the cache
	return raw as z.input<typeof userSchema>;  // valid input: the check passed
});
```

The cast is only needed where `loadUser` returns `unknown`; a typed source
returns `raw` as it is.

Returning `userSchema.parse(raw)` instead compiles only where no transform
changes a type, and even then runs the schema's transforms twice — once in the
loader, once in the cache.

A stored value that no longer matches — an older deploy's shape — is the
opposite case: it is treated as a **miss**, deleted, and read as `undefined`.

### `This message does not match the schema "orders" carries:`

**When:** `publish`, before anything is sent.
**Why:** the payload is checked against the channel's schema on the way out,
as a cache's value is. `code: 'INVALID'`.
**Fix:**

```ts
await publish(client, orders, { id, total: 12.5 }); // exactly what the schema declares
```

### `A message on "orders" does not match its schema:`

**When:** in a subscriber, on a message that was published by something else
— an older deploy, or another service writing to the same channel.
**Why:** each message is parsed before the handler sees it. The error does
**not** reach your caller: a listener's throw has nowhere to go, and Bun ends
the process on an unhandled rejection, so it goes to `onError` instead.
**Fix:**

```ts
const subscription = await subscribe(client, orders, handler, {
	onError: (error, raw) => log.warn({ error, raw }, 'unreadable message'),
});
```

Without `onError` it is written to `console.error`. An `onError` that throws
is caught and reported the same way.

### A published message never arrives

**When:** `publish` resolves with `0`, or with a number smaller than the
subscriber count you expected. There is no error.
**Why:** Redis pub/sub is fire-and-forget. The number is how many subscribers
Redis handed the message to, not a delivery guarantee: a subscriber that is
not connected at that instant never sees it, and nothing is replayed.
**Fix:**

```ts
const delivered = await publish(client, orders, payload);
if (delivered === 0) await queue.add(payload); // a stream or a queue, where it must not be lost
```

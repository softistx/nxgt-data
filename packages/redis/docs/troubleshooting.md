# Troubleshooting

This package throws two errors of its own. `GuardError` is the rate limits' and idempotency's, in
[its own part](#rate-limits-and-idempotency) of this page. `RedisError`, for everything else, has a `code` of
`LOCK_HELD`, `LOCK_LOST`, `INVALID`, `CONNECTION` or `PING_TIMEOUT`, and the
key or channel it happened on as `key` — never the value. `CONNECTION` and
`PING_TIMEOUT` are about the client rather than one key, so their `key` is
the empty string; it is never the URI, because a connection string holds the
password. Everything else comes from Bun's `RedisClient` as it is.

`defineCache`, `defineChannel`, `defineRedis` and `openRedis` check their
arguments before anything connects (the last two are
[their own part](#wiring-defineredis-and-openredis) of this page), and a URI already connected with other options is a plain
`TypeError` still: those are mistakes in the code, not something a running
application can handle.

- **Install and import**
  - [`Cannot find package 'bun'`](#cannot-find-package-bun)
  - [`Cannot find module 'bun' or its corresponding type declarations.`](#cannot-find-module-bun-or-its-corresponding-type-declarations)
  - [`Cannot find module 'zod' or its corresponding type declarations.`](#cannot-find-module-zod-or-its-corresponding-type-declarations)
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
- **Wiring** (`defineRedis` and `openRedis`)
  - [`Property 'users' does not exist on type 'never'.`](#property-users-does-not-exist-on-type-never)
  - [`Property 'users' does not exist on type 'CacheScope<Record<never, never>>'.`](#property-users-does-not-exist-on-type-cachescoperecordnever-never)
  - [`Property 'login' does not exist on type 'LimitScope<Record<never, never>>'.`](#property-login-does-not-exist-on-type-limitscoperecordnever-never)
  - [`defineRedis: instance "default" has neither uri nor client. Give it one.`](#defineredis-instance-default-has-neither-uri-nor-client-give-it-one)
  - [`defineRedis: instance "default" has both uri and client. Pass the URI to connect to, or the client you already opened.`](#defineredis-instance-default-has-both-uri-and-client-pass-the-uri-to-connect-to-or-the-client-you-already-opened)
  - [`defineRedis: instance "default" has clientOptions beside a client. The client was opened with its own; pass a uri, or drop the options.`](#defineredis-instance-default-has-clientoptions-beside-a-client-the-client-was-opened-with-its-own-pass-a-uri-or-drop-the-options)
  - [`defineRedis: instance "default" has an empty prefix. Leave it out, or give it a name.`](#defineredis-instance-default-has-an-empty-prefix-leave-it-out-or-give-it-a-name)
  - [`defineRedis: instance "default" wires no cache, no channel, no rate limit and no idempotency. Pass the module that exports them, or drop the instance.`](#defineredis-instance-default-wires-no-cache-no-channel-no-rate-limit-and-no-idempotency-pass-the-module-that-exports-them-or-drop-the-instance)
  - [`openRedis: instance "main" wires no cache, no channel, no rate limit and no idempotency. …`](#defineredis-instance-default-wires-no-cache-no-channel-no-rate-limit-and-no-idempotency-pass-the-module-that-exports-them-or-drop-the-instance) — the same, from `openRedis`
  - [`defineRedis: instance "default" wires the cache named "user" twice, under "users" and "people". They would share every key in Redis. Export one of them, or give it a name of its own.`](#defineredis-instance-default-wires-the-cache-named-user-twice-under-users-and-people-they-would-share-every-key-in-redis-export-one-of-them-or-give-it-a-name-of-its-own)
  - [`defineRedis: instance "default" wires the rate limit named "login" twice, …` (and `wires the idempotency named …`, `wires the channel named …`)](#defineredis-instance-default-wires-the-cache-named-user-twice-under-users-and-people-they-would-share-every-key-in-redis-export-one-of-them-or-give-it-a-name-of-its-own)
  - [`defineRedis: instance "default" wires the cache "users" and the rate limit "login" under one name, "user". They would share every key in Redis. Give one of them a name of its own.`](#defineredis-instance-default-wires-the-cache-users-and-the-rate-limit-login-under-one-name-user-they-would-share-every-key-in-redis-give-one-of-them-a-name-of-its-own)
  - [``defineRedis: `instances` is empty. Give it one, or write the single instance as the configuration itself.``](#defineredis-instances-is-empty-give-it-one-or-write-the-single-instance-as-the-configuration-itself)
  - [`openRedis: instance "main" has neither uri nor client. Give it one.`](#openredis-instance-main-has-neither-uri-nor-client-give-it-one)
  - [`cache: this Redis holds 2 Redis instances, and this call lives on one. Name it, as { on: 'cache' }.`](#cache-this-redis-holds-2-redis-instances-and-this-call-lives-on-one-name-it-as--on-cache-)
  - [`lock: this Redis has no instance named "events". It wires "cache", "pubsub".`](#lock-this-redis-has-no-instance-named-events-it-wires-cache-pubsub)
  - [A key, a channel or a lock is not where you expect it in `redis-cli`](#a-key-a-channel-or-a-lock-is-not-where-you-expect-it-in-redis-cli)
  - [Every rate limit starts full again, or a retried request ran twice, after moving to the wired guards](#every-rate-limit-starts-full-again-or-a-retried-request-ran-twice-after-moving-to-the-wired-guards)
  - [The process does not exit, or the connection count climbs](#the-process-does-not-exit-or-the-connection-count-climbs)
  - [A client the configuration handed in is still open after `redis.close()`](#a-client-the-configuration-handed-in-is-still-open-after-redisclose)
- **Rate limits and idempotency** (`GuardError`)
  - *Configuration*
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
  - *Runtime: rate limits*
    - [`enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again`](#enforce-on-login-the-limit-of-5-per-60000ms-is-spent-retryafter-says-when-to-try-again)
    - [`consume on "login": a cost must be a whole number from 1 to the burst of 5`](#consume-on-login-a-cost-must-be-a-whole-number-from-1-to-the-burst-of-5)
    - [`peek on "login": a cost must be a whole number from 0 to the burst of 5`](#peek-on-login-a-cost-must-be-a-whole-number-from-0-to-the-burst-of-5)
    - [A limit allows more than `limit` requests in its first `per`](#a-limit-allows-more-than-limit-requests-in-its-first-per)
    - [A limit barely limits anything](#a-limit-barely-limits-anything)
    - [Every limited caller has to wait much longer than `per`](#every-limited-caller-has-to-wait-much-longer-than-per)
    - [`WRONGTYPE Operation against a key holding the wrong kind of value`](#wrongtype-operation-against-a-key-holding-the-wrong-kind-of-value)
  - *Runtime: idempotency*
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
  - *Runtime: Redis itself*
    - [`Connection closed`](#connection-closed)

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

### `Cannot find module 'zod' or its corresponding type declarations.`

**When:** typechecking, reported in this package's own declarations
(`dist/idempotency/types.d.ts` and its neighbours), in a project where `zod`
is not installed — peers turned off (`peer = false` under `[install]` in
`bunfig.toml`), or an installer that leaves peers out. Bun installs a missing
peer by itself otherwise. Running the code does not fail: nothing in it
loads `zod`.
**Why:** `zod` is a required peer, for the **types** only: every
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
import { z } from 'zod';
import {
	type BoundCache,
	bindCache,
	connectRedis,
	defineCache,
	type InputOf,
	type ParamsOf,
	type ValueOf,
} from '@nxgt/redis';

const seenCache = defineCache({
	name: 'seen',
	key: (id: string) => id,
	ttl: 60,
	schema: z.string().transform((s) => new Date(s)),
});

type Seen = BoundCache<
	ParamsOf<typeof seenCache>,
	ValueOf<typeof seenCache>,
	InputOf<typeof seenCache>
>;

const redis = await connectRedis(process.env.REDIS_URL!);
const seen: Seen = bindCache(redis.client, seenCache);

// Wherever the raw value comes from: the string the schema accepts.
const loadRaw = async (_id: string): Promise<string> => '2026-09-22T10:00:00Z';
const raw = await loadRaw('u1');

await seen.set('u1', raw);                            // the string, not the Date
await seen.remember('u1', () => loadRaw('u1'));       // the loader returns the input too
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

## Wiring: `defineRedis` and `openRedis`

Everything in this part is a bare `TypeError` raised at **wiring time**, or a type error on the object `openRedis` gives back; the sentence names the instance and what to do, and no request produces one. What a *call* on a wired cache, channel, lock, rate limit or idempotency throws is the `RedisError` described above, with the instance's prefix in the key it names: a value refused by `redis.cache.users.set` reads `This value does not match the schema "myapp:prod:user" stores:`, a lock `The lock "myapp:import" is held by somebody else …`, a message `A message on "myapp:prod:user.created" does not match its schema:`. A wired guard's `GuardError` carries the prefixed name, as a cache's `RedisError` does: `enforce on "myapp:prod:login": the limit of 5 per 60000ms is spent; …`, with `definition` `myapp:prod:login`. The headings of the guard entries below say `login`, the name without a prefix.

`redis.ping()` never throws: it answers `{ ok: false, error }`, and that `error` is the same `RedisError`, `code: 'PING_TIMEOUT'`, message `ping: no answer in 2000ms`, whether `openRedis` opened the client or the configuration handed one in.

### Wiring types

#### `Property 'users' does not exist on type 'never'.`

**When:** compiling `redis.cache.users` — or `redis.channels.created` — on an object
whose configuration names more than one instance. The whole line is a
`TS2339`.
**Why:** `redis.cache` and `redis.channels` are the shortcut to the **sole**
instance, and an object that holds several has no sole one: their type is
`never`, measured both ways in this package's type tests, so every key read
off them is this error. It is the compile-time half of
[the refusal below](#cache-this-redis-holds-2-redis-instances-and-this-call-lives-on-one-name-it-as--on-cache-),
which is what a JavaScript call site gets instead.
**Fix:** say which Redis:

```ts
await redis.instances.cache.cache.users.get(id);
await redis.instances.pubsub.channels.created.publish(user);
```

#### `Property 'users' does not exist on type 'CacheScope<Record<never, never>>'.`

**When:** compiling a cache read off an instance that wires **only channels**
— `redis.instances.pubsub.cache.users`. A channel read off a cache-only
instance is the mirror image, and reads
`Property 'created' does not exist on type 'ChannelScope<Record<never, never>>'.`
**Why:** every instance is typed by the modules *it* was given, so an
instance configured with `channels` alone has an empty cache scope —
`Record<never, never>` is that empty module — and no key on it. Usually the
wrong instance named, or a definition exported from the module the other
instance wires.
**Fix:** read it off the instance that wires it:

```ts
const config = defineRedis({
	instances: {
		cache: { uri, prefix: 'myapp', caches },
		pubsub: { uri, prefix: 'myapp', channels },
	},
});

await redis.instances.cache.cache.users.get(id);              // the caches live here
await redis.instances.pubsub.channels.created.publish(user);  // the channels there
```

`RedisOf<typeof config>` is the type of that object, for a function that takes it
as a parameter; it carries the same keys, so the two errors above are what it
refuses too.

#### `Property 'login' does not exist on type 'LimitScope<Record<never, never>>'.`

**When:** compiling `redis.limits.login` — or `redis.idempotency.orders`, whose
mirror image reads `Property 'orders' does not exist on type
'IdempotencyScope<Record<never, never>>'.` — on an instance that wires no
rate limit (no idempotency). With several instances `redis.limits` is `never`
instead: the first entry above, with `limits` for `cache`.
**Why:** the same as for caches: every instance is typed by the modules *it* was
given, and one with no `limits` has an empty scope. Usually the wrong instance
named, `limits` left out of the configuration, or a definition of another kind:
each slot keeps only its own — a rate limit is wired from `limits` alone, an
idempotency from `idempotency` alone, and a cache from `caches`, so
`redis.limits.users` for a cache `users` is this error, whichever slot the
module was passed to.
**Fix:** wire it, and read it off the instance that wires it:

```ts
const config = defineRedis({ uri, prefix: 'myapp', limits, idempotency });
await redis.limits.login.enforce({ ip });
await redis.idempotency.orders.run({ user, key }, () => placeOrder());
```

### Wiring configuration

Everything below is a bare `TypeError` from `defineRedis`, thrown where the
configuration is written — it connects to nothing, so a wrong URI is not one
of them.

The same checks run again in `openRedis`, on the same configuration: a config
is often built in one file and connected in another, and the second is where
the stack trace is useful. **The sentence names the call it came from**, so
the same mistake reads `defineRedis: instance "main" …` from one and
`openRedis: instance "main" …` from the other; every heading below has that
second form, word for word after the colon.

#### `defineRedis: instance "default" has neither uri nor client. Give it one.`

**When:** calling `defineRedis`. A single instance names itself `default`;
with `instances: { … }` the name is the key you wrote.
**Why:** an instance says where its Redis is exactly once. This is nearly
always an environment variable that was not read — `process.env.REDIS_URL` is
`undefined`, so the property is absent.
**Fix:** read it where the application reads its other settings, and fail
there:

```ts
const uri = process.env.REDIS_URL;
if (!uri) throw new Error('REDIS_URL is not set');

export const config = defineRedis({ uri, prefix: 'myapp:prod', caches, channels });
```

#### `defineRedis: instance "default" has both uri and client. Pass the URI to connect to, or the client you already opened.`

**When:** calling `defineRedis` with `uri` **and** `client`.
**Why:** the two differ in who closes what: with a `uri` `openRedis` opens the
client and `close()` gives it back, with a `client` it uses yours and never
closes it. It will not guess which you meant.
**Fix:**

```ts
defineRedis({ client: connection.client, caches, channels });  // yours to close
```

#### `defineRedis: instance "default" has clientOptions beside a client. The client was opened with its own; pass a uri, or drop the options.`

**When:** calling `defineRedis` with `client` and `clientOptions`.
**Why:** `clientOptions` is what `openRedis` hands the driver **when it opens** a
client. A client that is already open cannot take them, so they would be
silently ignored.
**Fix:** give them where the client is made:

```ts
const connection = await connectRedis(uri, { autoReconnect: false });
defineRedis({ client: connection.client, caches, channels });
```

#### `defineRedis: instance "default" has an empty prefix. Leave it out, or give it a name.`

**When:** calling `defineRedis` with `prefix: ''`, or a prefix of spaces —
usually a deployment name read from an environment variable that is unset.
**Why:** an empty prefix would write `:user:ada`, a keyspace that belongs to
no deployment and matches nobody's `SCAN`. No prefix at all is a supported
choice; an empty one is a mistake.
**Fix:**

```ts
defineRedis({ uri, prefix: process.env.REDIS_PREFIX ?? 'myapp:dev', caches });
```

#### `defineRedis: instance "default" wires no cache, no channel, no rate limit and no idempotency. Pass the module that exports them, or drop the instance.`

**When:** calling `defineRedis` with no `caches`, `channels`, `limits` and
`idempotency`, or with objects that hold no definition in them. (Before 0.6.0
it read `wires no cache and no channel`.)
**Why:** definitions are recognised **by shape** — a cache has a `name`, a
`key` function, a numeric `ttl` and a `schema`; a channel has a `name` and a
`schema` and no `ttl`; a rate limit has a `name`, a `key` function, a `limit`
and a `per`; an idempotency is a cache's shape with a numeric `lease`. An object that holds none of those is usually a module
of types only, a default export read as a namespace, or a barrel that
re-exports builders rather than definitions.
**Fix:** pass the module as it is:

```ts
// src/redis/caches.ts
export const users = defineCache({ name: 'user', key: (id: string) => id, ttl: 300, schema });

// src/redis/index.ts
import * as caches from './caches';
import * as channels from './channels';

export const config = defineRedis({ uri, caches, channels, limits, idempotency });
```

Anything else in those modules — a schema, a type, a constant — is skipped,
not refused, and so is a definition of another kind: each slot keeps only its
own, so one module may be passed to several slots. A cache passed as `limits`
alone, an idempotency whose `lease` was overwritten with something that is not
a number, a rate limit with no `per`: none is wired, and an instance left with
nothing is this error.

#### `defineRedis: instance "default" wires the cache "users" and the rate limit "login" under one name, "user". They would share every key in Redis. Give one of them a name of its own.`

**When:** calling `defineRedis` — or `openRedis`, on a configuration built
elsewhere — with a cache, a rate limit and an idempotency, any two of them,
that have one `name` on one instance. The sentence names both kinds, and the
export keys they are wired under.
**Why:** all three write `<name>:<key>` — a cache a string, a rate limit a
string, an idempotency a hash — so one name is one keyspace. An idempotency
meets the other's string as `WRONGTYPE`, and a cache and a rate limit read and
overwrite each other's values: a cache entry that is not a bucket reads as a
full one, and the bucket's next write replaces the cache entry. Only **names** are compared,
never what a key function would build: two names that differ are fine whatever
their keys look like. Channels are not in this check — a pub/sub name is not a
key — so a channel may be named like a cache. The check is per instance, and
runs at wiring time only; nothing is compared while the application runs.
**Fix:** rename one of them — the **definition's** `name`, not its export:

```ts
export const sessions = defineCache({ name: 'session', /* … */ });
export const sessionLimit = defineRateLimit({ name: 'session.limit', /* … */ });
```

#### `defineRedis: instance "default" wires the cache named "user" twice, under "users" and "people". They would share every key in Redis. Export one of them, or give it a name of its own.`

**When:** calling `defineRedis` (or `openRedis`: the same sentence, from it). The same sentence covers channels, as
`wires the channel named "user.created" twice`, rate limits, as `wires the rate
limit named "login" twice`, and idempotent operations, as `wires the
idempotency named "orders.create" twice`.
**Why:** two exports point at **one** definition, or at two definitions with
the same `name`. Both keys would write the same Redis keys, so one of them is
silently dead: `redis.cache.people.delete(id)` empties what
`redis.cache.users.set(id, value)` wrote. It is a copy-paste in the module that
exports them, and nothing downstream can see it.
**Fix:** one `name` per definition, and one export per definition:

```ts
export const users = defineCache({ name: 'user', key, ttl: 300, schema });
export const people = defineCache({ name: 'person', key, ttl: 300, schema });
```

The **export** name is what the application reads (`redis.cache.users`); the
definition's `name` is what Redis holds. Two definitions may share an export
name across two modules, but never a `name` on one instance.

The check is also **across** the cache, rate-limit and idempotency kinds, which
share `<name>:<key>`: see [the entry above](#defineredis-instance-default-wires-the-cache-users-and-the-rate-limit-login-under-one-name-user-they-would-share-every-key-in-redis-give-one-of-them-a-name-of-its-own).

#### ``defineRedis: `instances` is empty. Give it one, or write the single instance as the configuration itself.``

**When:** calling `defineRedis({ instances: {} })` — typically an
`instances` object built at run time from environment variables that were not
set.
**Why:** the multi-instance shape was used and nothing came out of it. A configuration
with no instance has nothing to wire and nothing to close.
**Fix:**

```ts
defineRedis({ uri, caches, channels });                        // one Redis
defineRedis({ instances: { cache: { uri, caches } } });        // several
```

### Connecting

#### `openRedis: instance "main" has neither uri nor client. Give it one.`

**When:** `await openRedis(config)`, on a `RedisConfig` that did not come from
`defineRedis` — a configuration assembled by hand, or one cast through
`as never`.
**Why:** the checks run again where the clients are opened, so a
configuration built in one file and connected in another is refused at the
call a stack trace points at. **The sentence names the call that raised it**:
the same wiring mistake reads `defineRedis: …` from `defineRedis` and
`openRedis: …` from here, rather than always sending a reader to the wrong
file. Every `defineRedis: …` entry above has this second form.
**Fix:** build the configuration with `defineRedis`, which is where the
check belongs:

```ts
export const config = defineRedis({ uri, caches, channels });
export const redis = await openRedis(config);
```

### Wiring runtime

#### `cache: this Redis holds 2 Redis instances, and this call lives on one. Name it, as { on: 'cache' }.`

**When:** reading `redis.cache` on an object built from `instances: { … }` with
more than one of them. `redis.channels`, `redis.limits` and `redis.idempotency`
throw the same sentence under their own names, and so does `redis.lock` when no
`{ on }` was given.
**Why:** those five are the shortcut to the **sole** instance. With several
there is no sole one, and guessing is how a write lands on the wrong Redis —
so their type is already `never`, and this is what a JavaScript call site, or
one that went through an `any`, gets at run time.
**Fix:** name the instance:

```ts
await redis.instances.cache.cache.users.get(id);
await redis.instances.pubsub.channels.created.publish(user);
await redis.instances.cache.limits.login.enforce({ ip });
await redis.lock('import', importEverything, { on: 'cache' });
```

A single instance is named `default`, so `redis.instances.default.cache`
and `redis.cache` are the same object.

#### `lock: this Redis has no instance named "events". It wires "cache", "pubsub".`

**When:** `redis.lock(key, work, { on })` with a name the configuration does
not hold. It comes back as a **rejection**, not a synchronous throw, so one
`catch` covers it and whatever the work does.
**Why:** the names are the keys of `instances` in the configuration — not the
host, not the database number. `{ on: 'events' }` does not compile; this is the
run-time half of that, for a name that came from a variable or a cast.
**Fix:**

```ts
await redis.lock('import', importEverything, { on: 'cache' });  // a key of `instances`
```

Reading `redis.instances.<name>` for a name that is not there does not throw:
it does not compile, and gives `undefined` where the types were bypassed.

#### A key, a channel or a lock is not where you expect it in `redis-cli`

**When:** looking for a value the application says it wrote, and getting
`(nil)`.
**Why:** the instance's prefix is in front of everything it writes, and a
cache's, a rate limit's and an idempotency's key is `<name>:<key>` — a cache wired as `users` with `name: 'user'`
under `prefix: 'myapp:prod'` writes `myapp:prod:user:ada`, and the channel
`user.created` is published on `myapp:prod:user.created`. The lock is the one
that surprises: `withLock` writes `` `lock:${key}` `` itself
and the wiring hands it the already-prefixed key, so the prefix lands **inside**
`lock:` — `lock:myapp:prod:import`, never `myapp:prod:lock:import`. Both are
measured in the specs.
**Fix:** ask the object for the string rather than spelling it by hand:

```ts
redis.cache.users.keyFor('ada');       // 'myapp:prod:user:ada'
redis.limits.login.keyFor({ ip });     // 'myapp:prod:login:203.0.113.7'
redis.channels.created.name;           // 'myapp:prod:user.created'
redis.instances.default.prefix;        // 'myapp:prod'  — a lock is `lock:${prefix}:${key}`
```

A definition is never renamed in place: the prefix is applied to a copy, so
two objects may wire one definition under two prefixes, and a staging process
and a production one share the module without sharing a keyspace.

#### Every rate limit starts full again, or a retried request ran twice, after moving to the wired guards

**When:** right after an application moves a guard from
`bindRateLimit(client, login)` / `bindIdempotency(client, orders)` to
`redis.limits.login` / `redis.idempotency.orders`, on an instance with a
`prefix`. Callers who were at their limit get through; a client's retry of a
request that ran just before the deploy runs **again**.
**Why:** a guard bound by hand writes `login:<ip>`; a wired one writes
`<prefix>:login:<ip>`. The new code looks under keys the old code never wrote,
so it sees no count and no stored result. Nothing is lost — the old keys sit
there until they expire — they are simply not read.
**Fix:** none is needed beyond knowing it: the counts rebuild within `per`, and
an idempotency record is only needed for a retry that arrives within its `ttl`.
Move at a quiet moment. To carry on *without* the restart, leave the instance
without a `prefix` (the keys are then the same), or keep binding by hand. Check
what was written with `keyFor`:

```ts
redis.limits.login.keyFor({ ip });      // 'myapp:prod:login:203.0.113.7'
bindRateLimit(client, login).keyFor({ ip });  // 'login:203.0.113.7'
```

### Closing

#### The process does not exit, or the connection count climbs

**When:** after the work is done — a script that hangs instead of exiting, or
a long-running process whose `CLIENT LIST` on the server keeps growing.
**Why:** every `subscribe` holds a **connection duplicated from the client**,
and one nobody closes is a socket nobody gives back. `openRedis` records each
subscription it starts, so `redis.close()` closes the ones nobody did, then the
clients it opened — in that order, because unsubscribing on a closed client
is an error nobody asked for. A subscription started on an object that is never
closed outlives everything.
**Fix:** close the subscription where it ends, and the object where the process
does:

```ts
await using redis = await openRedis(config);

const running = await redis.channels.created.subscribe((user) => console.log(user.email));
await running.close();     // or hold it with `await using`, or leave it to `redis.close()`
```

`close()` is idempotent, on the subscription and on the object, so an early
close and the object's own close cannot collide.

#### A client the configuration handed in is still open after `redis.close()`

**When:** `await redis.close()`, or the end of an `await using` block, on an
instance configured with `client:` rather than `uri:`.
**Why:** deliberate, and measured: `close()` gives back what `openRedis` **opened**. A
client an application opened itself is usually shared with something else, so
taking it away at its shutdown would break whatever holds it too. The
subscriptions it started on that client are still closed — those are
its.
**Fix:** close it where it was opened:

```ts
const connection = await connectRedis(process.env.REDIS_URL!);
const redis = await openRedis(defineRedis({ client: connection.client, caches, channels }));

await redis.close();          // subscriptions closed, the client untouched
await connection.close();   // yours, so yours to give back
```

## Rate limits and idempotency

The next four parts are `defineRateLimit`, `bindRateLimit`, `defineIdempotency` and `bindIdempotency`. They throw their own error, `GuardError`, not
`RedisError`: a `code` of `RATE_LIMITED` or `COST` from a rate limit, `IN_PROGRESS`, `MISMATCH`, `INVALID` or `LEASE_LOST` from an idempotent `run`, and the
`definition` it happened on — its `name`, never the key it built, the params, a fingerprint or a result, which came from a request. `RATE_LIMITED` and `IN_PROGRESS` also
carry `retryAfter`, in milliseconds. An error thrown by your own `work` passes through `run` untouched. The four functions check a definition before anything is sent, and throw a plain `TypeError`:
those are mistakes in the code. The headings say `defineRateLimit` and `defineIdempotency`; the same refusal from a `bind*`, for a definition written by hand, names that call instead.

## Rate limits and idempotency: configuration

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

## Rate limits: runtime

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

## Idempotency: runtime

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
  gives it back, so it **may** stay running until its lease lapses: a repeat
  before then gets `IN_PROGRESS`, and one after it runs `work` again. If
  only the reply was lost, the store **may** have happened, and a repeat
  replays the result instead;
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

## Rate limits and idempotency: Redis itself

### `Connection closed`

**When:** any call, while Redis cannot be reached — `consume`, `enforce`,
`peek` and `reset` on a limit, `run` and `forget` on an idempotent operation.
It is Bun's own Redis error, not a `GuardError` nor a `RedisError`. The message depends on the
client's reconnect options; the `code` does not. Measured on Bun 1.4.2, every
one carries `code: 'ERR_REDIS_CONNECTION_CLOSED'`:

| Client | First call | Every call after |
| --- | --- | --- |
| Bun's defaults (reconnects) | `Max reconnection attempts reached`, after about 31 s of retrying | `Connection has failed`, at once |
| `autoReconnect: false` | `Connection has failed`, at once | `Connection has failed`, at once |

Either way, a call already sent when the connection drops rejects with
`Connection closed`, at once; so does a first call on an `autoReconnect: false`
client that never connected.

A server's refusal — `WRONGTYPE` and the like — comes back the same way,
unwrapped, with another `code` (`ERR_REDIS_SERVER_ERROR`).
**Why:** `bindRateLimit` and `bindIdempotency` open no connection of their own, retry nothing and
have no fallback: every step is one script, or a `DEL`, on your `RedisClient`,
and an error from it passes through as it is, not wrapped. Where it happens
in `run` decides what it means:

| Redis failed | `run` | `work` |
| --- | --- | --- |
| taking the key, or polling it during `wait` | rejects with Redis's error. If only the reply was lost, the key **may** be held: repeats get `IN_PROGRESS` for up to a `lease` | not called |
| renewing the lease while `work` runs | nothing: tried again at the next beat | runs on; the lease is lost only if no renewal gets through for a whole `lease` |
| storing the result | rejects with Redis's error. The key **may** stay running until its lease lapses — or, if only the reply was lost, the result **may** be stored, and a repeat replays it | **has run** — see [The same request ran twice](#the-same-request-ran-twice) |
| giving the key back after `work` threw | rejects with `work`'s own error; the key lapses with its lease | threw |

On a limit, a failed check may or may not have counted: the script is one
atomic step, but its reply can be lost after it ran.
**Fix:** answer it where the request is answered — a 503 rather than a 500,
since the request itself was fine — and decide per route whether a limit
that cannot be checked lets the caller through:

```ts
/** A 503 when Redis cannot be reached; undefined for anything else. */
export function redisUnavailable(error: unknown): Response | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && code === 'ERR_REDIS_CONNECTION_CLOSED') {
		return new Response('Try again shortly', { status: 503, headers: { 'Retry-After': '5' } });
	}
	return undefined;
}
```

It reads `code`, not `name`: Bun does not export its error class, so there is
no `instanceof`, and `name` is `'RedisError'` for a server's refusal too — and
for other libraries' errors, `RedisError` of this package among them — so a check on it
would answer a `WRONGTYPE` from a misconfigured name with 503 instead of the
500 it is.

The [roadmap](roadmap.md#not-planned) says why there is no in-memory
fallback.

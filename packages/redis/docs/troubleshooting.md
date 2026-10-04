# Troubleshooting

This package throws one error of its own, `RedisError`, with a `code` of
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
  - [`defineRedis: instance "default" has neither uri nor client. Give it one.`](#defineredis-instance-default-has-neither-uri-nor-client-give-it-one)
  - [`defineRedis: instance "default" has both uri and client. Pass the URI to connect to, or the client you already opened.`](#defineredis-instance-default-has-both-uri-and-client-pass-the-uri-to-connect-to-or-the-client-you-already-opened)
  - [`defineRedis: instance "default" has clientOptions beside a client. The client was opened with its own; pass a uri, or drop the options.`](#defineredis-instance-default-has-clientoptions-beside-a-client-the-client-was-opened-with-its-own-pass-a-uri-or-drop-the-options)
  - [`defineRedis: instance "default" has an empty prefix. Leave it out, or give it a name.`](#defineredis-instance-default-has-an-empty-prefix-leave-it-out-or-give-it-a-name)
  - [`defineRedis: instance "default" wires no cache and no channel. Pass the module that exports them, or drop the instance.`](#defineredis-instance-default-wires-no-cache-and-no-channel-pass-the-module-that-exports-them-or-drop-the-instance)
  - [`defineRedis: instance "default" wires the cache named "user" twice, under "users" and "people". They would share every key in Redis. Export one of them, or give it a name of its own.`](#defineredis-instance-default-wires-the-cache-named-user-twice-under-users-and-people-they-would-share-every-key-in-redis-export-one-of-them-or-give-it-a-name-of-its-own)
  - [``defineRedis: `instances` is empty. Give it one, or write the single instance as the configuration itself.``](#defineredis-instances-is-empty-give-it-one-or-write-the-single-instance-as-the-configuration-itself)
  - [`openRedis: instance "main" has neither uri nor client. Give it one.`](#openredis-instance-main-has-neither-uri-nor-client-give-it-one)
  - [`cache: this Redis holds 2 Redis instances, and this call lives on one. Name it, as { on: 'cache' }.`](#cache-this-redis-holds-2-redis-instances-and-this-call-lives-on-one-name-it-as--on-cache-)
  - [`lock: this Redis has no instance named "events". It wires "cache", "pubsub".`](#lock-this-redis-has-no-instance-named-events-it-wires-cache-pubsub)
  - [A key, a channel or a lock is not where you expect it in `redis-cli`](#a-key-a-channel-or-a-lock-is-not-where-you-expect-it-in-redis-cli)
  - [The process does not exit, or the connection count climbs](#the-process-does-not-exit-or-the-connection-count-climbs)
  - [A client the configuration handed in is still open after `redis.close()`](#a-client-the-configuration-handed-in-is-still-open-after-redisclose)

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

Everything in this part is a bare `TypeError` raised at **wiring time**, or a type error on the object `openRedis` gives back; the sentence names the instance and what to do, and no request produces one. What a *call* on a wired cache, channel or lock throws is the `RedisError` described above, with the instance's prefix in the key it names: a value refused by `redis.cache.users.set` reads `This value does not match the schema "myapp:prod:user" stores:`, a lock `The lock "myapp:import" is held by somebody else …`, a message `A message on "myapp:prod:user.created" does not match its schema:`.

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

#### `defineRedis: instance "default" wires no cache and no channel. Pass the module that exports them, or drop the instance.`

**When:** calling `defineRedis` with no `caches` and no `channels`, or with
objects that hold no definition in them.
**Why:** definitions are recognised **by shape** — a cache has a `name`, a
`key` function, a numeric `ttl` and a `schema`; a channel has a `name` and a
`schema` and no `ttl`. An object that holds none of those is usually a module
of types only, a default export read as a namespace, or a barrel that
re-exports builders rather than definitions.
**Fix:** pass the module as it is:

```ts
// src/redis/caches.ts
export const users = defineCache({ name: 'user', key: (id: string) => id, ttl: 300, schema });

// src/redis/index.ts
import * as caches from './caches';
import * as channels from './channels';

export const config = defineRedis({ uri, caches, channels });
```

Anything else in those modules — a schema, a type, a constant — is skipped,
not refused.

#### `defineRedis: instance "default" wires the cache named "user" twice, under "users" and "people". They would share every key in Redis. Export one of them, or give it a name of its own.`

**When:** calling `defineRedis`. The same sentence covers channels, as
`wires the channel named "user.created" twice`.
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
more than one of them. `redis.channels` throws the same sentence under its own
name, and so does `redis.lock` when no `{ on }` was given.
**Why:** those three are the shortcut to the **sole** instance. With several
there is no sole one, and guessing is how a write lands on the wrong Redis —
so their type is already `never`, and this is what a JavaScript call site, or
one that went through an `any`, gets at run time.
**Fix:** name the instance:

```ts
await redis.instances.cache.cache.users.get(id);
await redis.instances.pubsub.channels.created.publish(user);
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
cache's key is `<name>:<key>` — a cache wired as `users` with `name: 'user'`
under `prefix: 'myapp:prod'` writes `myapp:prod:user:ada`, and the channel
`user.created` is published on `myapp:prod:user.created`. The lock is the one
that surprises: `withLock` writes `` `lock:${key}` `` itself
and the wiring hands it the already-prefixed key, so the prefix lands **inside**
`lock:` — `lock:myapp:prod:import`, never `myapp:prod:lock:import`. Both are
measured in the specs.
**Fix:** ask the object for the string rather than spelling it by hand:

```ts
redis.cache.users.keyFor('ada');       // 'myapp:prod:user:ada'
redis.channels.created.name;           // 'myapp:prod:user.created'
redis.instances.default.prefix;        // 'myapp:prod'  — a lock is `lock:${prefix}:${key}`
```

A definition is never renamed in place: the prefix is applied to a copy, so
two objects may wire one definition under two prefixes, and a staging process
and a production one share the module without sharing a keyspace.

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

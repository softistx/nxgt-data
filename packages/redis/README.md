# @nxgt/redis

Redis on **Bun's own client** — no third-party driver. One connection shared
per URI, caches and channels described once and typed from their schema, and a
lock that is safe to release.

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

`redis.client` is Bun's `RedisClient`, untouched: everything this package does
not wrap is still there.

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

## What it does not do

- **No `multi`/`exec`.** Bun's client has none, and 0.1.0 needs none: the lock
  is `SET NX PX`, one command, and its release is one script.
- **It does not retry for you.** Bun's client reconnects; a command that fails
  fails, and the error is Redis's own.
- **It is not a queue.** Pub/sub is fire-and-forget — see Traps.
- **It listens to no signal.** Closing on shutdown is yours, with `close()` or
  `closeRedis()`.

## API

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

| `BoundCache<P, T>` | |
| --- | --- |
| `keyFor(params)` | the key it would use, for a caller that needs the string |
| `get(params)` | the value, or `undefined` — a miss, an expiry, or a stale shape |
| `set(params, value, { ttl })` | checked against the schema first, then stored |
| `remember(params, load, { ttl })` | the value if it is there, otherwise what `load` gives, stored — and given back **as it was stored** |
| `delete(params)` | `true` when something was there |

| Type | |
| --- | --- |
| `CacheDefinition<P, S>` | what `defineCache` takes and gives back |
| `BoundCache<P, T>` | what `bindCache` gives back |
| `ParamsOf<D>` | the params a definition's `key` takes, for a caller writing its own helper |
| `ValueOf<D>` | what a definition's schema gives back |

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

## What does not compile

Each is a `@ts-expect-error` case in `test/types/redis.ts`.

- A cache read or written with the wrong key parameters, or the wrong value.
- A `key` that gives something other than a string, or a `ttl` that is not a
  number.
- A cache or a channel with no schema, a channel with no name.
- A cache definition passed to `publish`, or a channel definition to
  `bindCache` — they are otherwise structurally alike.
- A published payload the channel's schema does not describe, and a field a
  subscriber's handler reads that is not on it.
- An option `withLock` does not have.

## Traps

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
- **`close()` on one connection is not `closeRedis()`.** The first gives back
  one holder; the second takes every client away from everybody.
- **A connect that `closeRedis()` interrupts rejects, with `CONNECTION`.** At
  shutdown a request still connecting fails rather than get a closed client;
  connecting again opens a fresh one, since the failure was the race and not
  the URI.

## Documentation

- [docs/README.md](docs/README.md) — the guide index: connections, caches,
  locks and pub/sub, each with its options and a worked example.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT

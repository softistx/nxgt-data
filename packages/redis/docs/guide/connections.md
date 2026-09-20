# Connections

How to open a client, share it between the modules that need it, ask whether
it is healthy, and close it on the way out.

## The smallest thing that works

```ts
import { connectRedis } from '@nxgt/redis';

const redis = await connectRedis(process.env.REDIS_URL!);

await redis.client.set('greeting', 'hello');
console.log(await redis.client.get('greeting')); // 'hello'

await redis.close();
```

`redis.client` is Bun's own `RedisClient`, untouched: every command this
package does not wrap is still there. It is built into Bun, which is why
there is no driver in `bun add` — and why this package does not run on Node.

## The signatures

```ts
import type { RedisClient, RedisOptions } from 'bun';

function connectRedis(
	uri: string,
	options?: RedisOptions,
): Promise<RedisConnection>;

function closeRedis(): Promise<void>;

interface RedisConnection extends AsyncDisposable {
	readonly client: RedisClient;
	ping(options?: { timeoutMs?: number }): Promise<PingResult>;
	close(): Promise<void>;
}

type PingResult =
	| { readonly ok: true; readonly latencyMs: number }
	| { readonly ok: false; readonly error: unknown };
```

## One client per URI

Every `connectRedis` for the same URI gets the **same** `RedisClient`,
connected once even when the calls race. Each caller gets its own connection
object to close, and the client closes with the last one.

```ts
const uri = process.env.REDIS_URL!;

const first = await connectRedis(uri);
const second = await connectRedis(uri);

second.client === first.client; // true — one client, two holders

await first.close();
await second.client.set('still', 'here'); // one holder left: still usable

await second.close(); // the last holder: now the client is closed
```

So a module that needs Redis calls `connectRedis` itself rather than passing
a client down through five function signatures, and closes what it opened.
`close()` is idempotent: calling it twice does not drop a second holder.

## Options

`options` is **Bun's own `RedisOptions`**, passed straight to the client. The
ones that change how a connect behaves, with Bun 1.4's defaults:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `connectionTimeout` | `number` | `10_000` | milliseconds allowed for one connection attempt |
| `autoReconnect` | `boolean` | `true` | reconnects after a drop — and retries a first connect, which is why a connect to a dead port takes far longer than `connectionTimeout` |
| `maxRetries` | `number` | `20` | reconnection attempts before the client gives up |
| `idleTimeout` | `number` | `0` (none) | milliseconds of silence from the server before Bun closes the connection |
| `enableOfflineQueue` | `boolean` | `true` | queues commands issued while disconnected instead of failing them |
| `enableAutoPipelining` | `boolean` | `true` | sends commands issued in the same tick together |
| `tls` | `boolean \| Bun.TLSOptions` | — | TLS for a `rediss://` endpoint |

They are kept as a **copy**, so the object you passed is still yours to
change afterwards:

```ts
const options = { maxRetries: 3 };
await connectRedis(uri, options);
options.maxRetries = 9;              // the connection is unaffected
await connectRedis(uri, { maxRetries: 3 }); // still the same options: shared
```

**The same URI must be given the same options at every call.** A second call
that disagrees is refused:

```ts
await connectRedis(uri, { maxRetries: 3 });
await connectRedis(uri, { maxRetries: 9 });
// TypeError: connectRedis: this URI is already connected with other options.
```

The message never contains the URI: it may carry a password. See
[Troubleshooting](../troubleshooting.md) for the usual way to hit this — a
startup health check with `autoReconnect: false` beside an application that
connects without it.

## Health, without a throw

```ts
const health = await redis.ping({ timeoutMs: 500 });

if (health.ok) console.log('redis up', health.latencyMs);
else console.error('redis down', health.error);
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | `2_000` | how long to wait for `PONG` before answering `{ ok: false }` |

`ping` **never throws**: a health check reports, it does not fail. A timeout
comes back as `{ ok: false, error }` like anything else — and that error is a
`RedisError` with the code `PING_TIMEOUT`, so a health route can tell "no
answer in time" from "the server said no":

```ts
import { RedisError } from '@nxgt/redis';

const health = await redis.ping({ timeoutMs: 500 });

if (!health.ok && health.error instanceof RedisError) {
	health.error.code;    // 'PING_TIMEOUT'
	health.error.message; // 'ping: no answer in 500ms'
	health.error.key;     // '' — this one is about the connection, not a key
}
```

`PING_TIMEOUT` is the one code that is **returned and never thrown**. The
`key` is empty, and it is never the URI: a connection string holds the
password.

## Closing

```ts
await using redis = await connectRedis(uri); // closed at the end of the scope
```

`RedisConnection` is `AsyncDisposable`, so `await using` closes it for you —
the usual form in a script or a test.

`closeRedis()` is the other end: it closes **every** client this package
opened, whoever still holds one. It is for the end of a process or of a test
file, not for a request handler.

```ts
process.on('SIGTERM', () => {
	void closeRedis();
});
```

Nothing in this package listens to a signal on its own.

## A real one: a server that shares one client

```ts
import { Hono } from 'hono';
import { closeRedis, connectRedis } from '@nxgt/redis';

const redis = await connectRedis(process.env.REDIS_URL!);

const app = new Hono();

app.get('/health/redis', async (c) => {
	const health = await redis.ping({ timeoutMs: 500 });
	return health.ok
		? c.json({ ok: true, latencyMs: Math.round(health.latencyMs) })
		: c.json({ ok: false }, 503);
});

app.get('/counter', async (c) => {
	const hits = await redis.client.incr('counter');
	return c.json({ hits });
});

process.on('SIGTERM', () => {
	void closeRedis();
});

export default app;
```

A worker in the same process that calls `connectRedis(process.env.REDIS_URL!)`
gets this very client, not a second connection.

## What is thrown

| Thrown | `code` | When |
| --- | --- | --- |
| `TypeError` | — | a URI already connected with other options |
| `RedisError` | `CONNECTION` | `closeRedis()` ran while this connect was still connecting |
| `RedisError` | `PING_TIMEOUT` | `ping` gave up waiting — **returned** on `{ ok: false, error }`, never thrown |

`closeRedis()` closes every client at once, so a `connectRedis` that was
still waiting comes back holding nothing. It rejects rather than hand out a
closed client:

```ts
import { closeRedis, connectRedis, RedisError } from '@nxgt/redis';

const connecting = connectRedis(uri);
await closeRedis();                  // a shutdown, or the end of a test file

try {
	await connecting;
} catch (error) {
	if (error instanceof RedisError && error.code === 'CONNECTION') {
		// 'connectRedis: every client was closed while this one was connecting.'
	}
}

// Calling again opens a fresh client: the failure was the race, not the URI.
const redis = await connectRedis(uri);
```

Its `key` is `''`, like `PING_TIMEOUT`'s: both are about the connection rather
than one key, and neither is ever the URI.

**Redis's own refusal to connect is not this.** A port nothing listens on, a
wrong password, a server that is down: those are Bun's errors, and they reach
you unchanged. `CONNECTION` is only what this package decides.

This package's other codes — `LOCK_HELD`, `LOCK_LOST`, `INVALID` — belong to
[caches](cache.md), [locks](locks.md) and [pub/sub](channels.md).

## Next

- [Caches](cache.md) — `bindCache(redis.client, …)`.
- [Locks](locks.md) — `withLock(redis.client, …)`.
- [Pub/sub](channels.md) — `publish` and `subscribe`, which duplicates the
  client rather than holding this one.

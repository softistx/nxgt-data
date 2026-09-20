# Locks and health

`kit.lock` runs something while holding a Redis lock the deployment's prefix
keeps to itself, and `kit.ping` says whether the Redis instances the kit wires
are answering.

```ts
import { connectKit, defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';

const kit = await connectKit(
	defineConfig({ uri: process.env.REDIS_URL!, prefix: 'myapp', caches }),
);

const imported = await kit.lock('import', () => importEverything(), {
	ttl: 60_000,                           // milliseconds the lock is held
	wait: 5_000,                           // milliseconds to keep trying to take it
});

const health = await kit.ping();          // { default: { ok: true, latencyMs: 0.4 } }
```

The lock is `@nxgt/redis`'s `withLock` — `SET NX PX`, released by a script
that checks the token first — and `kit.lock` is where the key gets the
instance's prefix and, when the kit holds several Redis instances, the name of
the one it lives on.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `ttl` | `number` | `30_000` | milliseconds before Redis drops the lock. A **deadline for the work**, not a hint |
| `wait` | `number` | `0` | milliseconds to keep trying to take it. `0` refuses at once |
| `retryDelay` | `number` | `50` | milliseconds between tries |
| `on` | instance name | — | which Redis the lock lives on. Required when the kit holds several |

`ttl` is **milliseconds** here and **seconds** on a cache: a lock's deadline
is Redis's `PX`, a cache's is its `EX`. Whatever is still running when the
`ttl` passes is no longer protected.

## The key it takes

```ts
await kit.lock('import', work);      // with prefix 'myapp' → lock:myapp:import
```

The prefix lands **inside** `lock:`, not in front of it: `withLock` writes
`` `lock:${key}` `` itself, and this package does not reach into a sibling to
reorder it. Two deployments still never share a lock, which is what the prefix
is for — but a script reading the key by hand has to spell it
`lock:myapp:import`.

The lock is given back when the work returns, including when it throws.

## What it throws

```ts
import { RedisError } from '@nxgt/redis';

try {
	await kit.lock('invoices:nightly', sendInvoices, { ttl: 60_000 });
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') {
		return;                        // another worker has it; nothing ran
	}
	if (error instanceof RedisError && error.code === 'LOCK_LOST') {
		alert('nightly invoices overran their lock');   // it may have doubled
		return;
	}
	throw error;                       // the work's own failure, untouched
}
```

- **`LOCK_HELD`** — `wait` ran out and somebody else still holds it. Nothing
  ran: a scheduled job that catches it and moves on is usually right.
- **`LOCK_LOST`** — the work finished, but the lock had already expired, so it
  may have run beside another holder's. Thrown *after* the work returned, and
  its result is dropped.

Both are `@nxgt/redis`'s `RedisError`; the kit adds no error class. A lock
taken again from inside its own work is simply a second holder:

```ts
await kit.lock('import', () =>
	kit.lock('import', () => 'never', { wait: 0 }),    // → LOCK_HELD
);
```

Naming a Redis the kit does not have is this package's refusal instead, as a
`TypeError` — and as a **rejection**, not a synchronous throw, so one `catch`
covers the call:

```
kit.lock: this kit has no instance named "nope". It wires "cache", "pubsub".
```

## On one instance of several

```ts
await kit.lock('import', work, { on: 'cache' });       // says which Redis
await kit.instances.cache.lock('import', work);        // the same lock
```

`kit.lock` without `{ on }` on a kit that holds several instances rejects
rather than guess — see [instances and closing](instances.md).
`kit.instances.<name>.lock` is the same call with the instance already chosen,
and takes no `{ on }`.

## Health

```ts
const answered = await kit.ping({ timeoutMs: 500 });

if (answered.default.ok) {
	answered.default.latencyMs;        // a number of milliseconds
} else {
	answered.default.error;            // whatever went wrong
}
```

`ping` answers for **every** instance the kit holds, under its name, and
**never throws**: a health route always has something to report. It answers
within `timeoutMs` either way — 2 s by default — including when the client
came from the configuration rather than from the kit's own connect.

```ts
import { Hono } from 'hono';
import { kit } from './redis/kit';

export const health = new Hono().get('/health/redis', async (c) => {
	const answered = await kit.ping({ timeoutMs: 500 });
	const ok = Object.values(answered).every((one) => one.ok);
	return c.json(answered, ok ? 200 : 503);
});
```

`PingResult` is `@nxgt/redis`'s:
`{ ok: true; latencyMs: number } | { ok: false; error: unknown }`. It is a
discriminated union, so `latencyMs` is only reachable after `if (one.ok)`.

## The signatures

```ts
interface RedisKit<C> {
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: KitLockOptions<C>,
	): Promise<T>;
	ping(options?: { timeoutMs?: number }): Promise<Record<InstanceName<C>, PingResult>>;
}

type KitLockOptions<C> = LockOptions & {
	/** Which Redis the lock lives on. Required when the kit holds several. */
	on?: InstanceName<C>;
};
```

`lock` gives back exactly what `work` returned. `LockOptions` is
`@nxgt/redis`'s, and `{ on }` is stripped before it is passed on.

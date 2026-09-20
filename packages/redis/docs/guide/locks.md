# Locks

Running one piece of work at a time across every process that might start it:
a nightly job, a migration, a rebuild that must not happen twice.

## The smallest thing that works

```ts
import { connectRedis, withLock } from '@nxgt/redis';

const redis = await connectRedis(process.env.REDIS_URL!);

const answer = await withLock(redis.client, 'invoices:nightly', async () => {
	await sendInvoices();
	return 'sent';
});
// 'sent' — and the lock is already given back
```

The lock is taken with `SET NX PX` — one round trip, one step — under the key
`` `lock:<key>` ``, and released by a script that checks the token first. A
run that overran its `ttl` can never free the lock somebody else has since
taken.

## The signature

```ts
import type { RedisClient } from 'bun';

function withLock<T>(
	client: RedisClient,
	key: string,
	work: () => Promise<T> | T,
	options?: LockOptions,
): Promise<T>;

interface LockOptions {
	ttl?: number;
	wait?: number;
	retryDelay?: number;
}
```

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `ttl` | `number` | `30_000` | milliseconds the lock is held before Redis drops it. **In milliseconds**, unlike a [cache](cache.md)'s `ttl`, which is seconds |
| `wait` | `number` | `0` | milliseconds to keep trying to take it. `0` refuses at once |
| `retryDelay` | `number` | `50` | milliseconds between tries while waiting |

`ttl` is a **deadline for the work**, not a hint: whatever is still running
when it passes is no longer protected. Size it above the slowest run you are
willing to accept.

```ts
// Refuse at once if another worker has it: the default.
await withLock(redis.client, 'invoices:nightly', sendInvoices);

// Queue behind it for up to five seconds, trying every 200 ms.
await withLock(redis.client, 'invoices:nightly', sendInvoices, {
	wait: 5_000,
	retryDelay: 200,
});
```

Three callers racing with a `wait` long enough run one after another, never
side by side:

```ts
const run = () =>
	withLock(redis.client, 'job', () => rebuildIndex(), { wait: 2_000 });

await Promise.all([run(), run(), run()]); // three runs, one at a time
```

## What comes back, and what is thrown

`withLock` gives back exactly what `work` returned. An error `work` throws is
passed through untouched, and the lock is given back first.

| `RedisErrorCode` | When | What it means for the work |
| --- | --- | --- |
| `LOCK_HELD` | `wait` ran out and somebody else still holds it | **nothing ran** |
| `LOCK_LOST` | the work finished, but its lock had already expired | it ran, and it may have run beside another holder |

```ts
import { RedisError } from '@nxgt/redis';

try {
	await withLock(redis.client, 'invoices:nightly', sendInvoices, {
		ttl: 60_000,
		wait: 5_000,
	});
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') {
		return; // another worker has it; nothing ran, so move on
	}
	if (error instanceof RedisError && error.code === 'LOCK_LOST') {
		alert('nightly invoices overran their lock'); // it may have doubled
		return;
	}
	throw error; // the work's own failure
}
```

`error.key` is the Redis key — `lock:invoices:nightly` — and the message says
which lock and how long was waited. Neither carries a value.

`LOCK_LOST` is thrown **after** the work returned, so its result is lost
along with the guarantee. One more substitution to know about: if the work
succeeds but the release round trip itself fails — a connection blip — that
failure is what the caller sees, and the work's value is lost. The lock then
stays until its `ttl` runs out.

A process that dies holding a lock frees it anyway: the `ttl` is set in the
same command that takes it, so there is no window where a lock exists without
an expiry.

## A real one: a scheduled job that may start twice

```ts
import { connectRedis, RedisError, withLock } from '@nxgt/redis';

const redis = await connectRedis(process.env.REDIS_URL!);

export async function nightly(): Promise<void> {
	try {
		await withLock(
			redis.client,
			'invoices:nightly',
			async () => {
				for (const invoice of await dueInvoices()) await send(invoice);
			},
			{ ttl: 10 * 60_000, wait: 0 },
		);
	} catch (error) {
		if (error instanceof RedisError && error.code === 'LOCK_HELD') {
			console.info('another instance is already sending invoices');
			return;
		}
		throw error;
	}
}
```

A cron that fires on three instances runs the work on one of them, and the
other two log and stop.

## Nesting

A `withLock` inside another one is fine: each holds its own key and its own
token, and an inner `LOCK_LOST` is passed through as the error it is without
the outer call mistaking it for its own.

## What this is not

There is no lock extension and no watchdog: a lock lives for its `ttl` and
that is all. There is no `multi`/`exec` either — Bun's client has none, and
the lock needs none.

## Next

- [Caches](cache.md) — wrapping a `remember` so one loader runs.
- [Connections](connections.md) — where `redis.client` comes from.
- [Troubleshooting](../troubleshooting.md) — `LOCK_HELD` and `LOCK_LOST` in
  full.

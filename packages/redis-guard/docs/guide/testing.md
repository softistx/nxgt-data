# Testing code that uses it

How to test your own rate limits and idempotent operations with `bun test`:
against which Redis, how to start each spec from nothing, and why moving the
clock does not refill a bucket.

The blocks on this page make one spec file, `guards.spec.ts`; paste them in
order and run it with a Redis on `localhost`:

```sh
docker run --rm -d -p 6379:6379 redis:7.4
bun test guards.spec.ts
```

## A real Redis, one database per suite

```ts
import { afterAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	bindIdempotency,
	bindRateLimit,
	defineIdempotency,
	defineRateLimit,
	GuardError,
} from '@nxgt/redis-guard';

// A Redis of its own, or a database nobody else uses: FLUSHDB empties it.
const redis = new RedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379/15');

beforeEach(async () => {
	await redis.send('FLUSHDB', []);
});

afterAll(() => {
	redis.close();
});
```

- **There is no mock to swap in.** Every check is a Lua script the server
  runs — sent with `EVALSHA`, or `EVAL` when the server does not hold it yet —
  and the rate-limit script reads the server's `TIME` inside it. A stub of
  `RedisClient` would have to run Lua. Any Redis 5 or later will do; this
  package is tested against 7.4.
- **Empty it before each test.** A bucket or an idempotency key left by one
  test changes what the next one sees: a limit already spent, a result
  replayed instead of run. `FLUSHDB` empties the database in the URL (`/15`
  above); on a Redis used by nothing else, `FLUSHALL` does as well. To clear
  one key rather than everything, `reset(params)` refills a bucket and
  `forget(params)` deletes an idempotency key, running or done.
- **One client is enough for a spec.** This package opens no connection of
  its own — each `bind*` takes yours — so closing yours is the only cleanup.

## Idempotency

```ts
const createOrder = defineIdempotency({
	name: 'orders.create',
	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
	ttl: 3_600,
	schema: z.object({ orderId: z.string() }),
});

describe('placing an order', () => {
	const orders = bindIdempotency(redis, createOrder);
	const who = { user: 'u1', key: 'k1' };

	test('runs once, and a repeat gets the same order', async () => {
		let calls = 0;
		const work = () => {
			calls += 1;
			return { orderId: `o${calls}` };
		};
		const first = await orders.run(who, work);
		const again = await orders.run(who, work);
		expect(first).toEqual({ value: { orderId: 'o1' }, replayed: false });
		expect(again).toEqual({ value: { orderId: 'o1' }, replayed: true });
		expect(calls).toBe(1);
	});

	test('forget lets the same key run again', async () => {
		await orders.run(who, () => ({ orderId: 'o1' }));
		expect(await orders.forget(who)).toBe(true);
		const next = await orders.run(who, () => ({ orderId: 'o2' }));
		expect(next.replayed).toBe(false);
	});

	test('a repeat during the first run is IN_PROGRESS', async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const running = orders.run(who, async () => {
			started.resolve(); // work is called only once run holds the key
			await finish.promise;
			return { orderId: 'o1' };
		});
		await started.promise;

		const repeat = await orders.run(who, () => ({ orderId: 'o2' })).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(repeat).toBeInstanceOf(GuardError);
		expect((repeat as GuardError).code).toBe('IN_PROGRESS');

		finish.resolve();
		expect((await running).value).toEqual({ orderId: 'o1' });
	});
});
```

- **Hold a running key with a promise you resolve**, not a sleep: `work` is
  called only once `run` has taken the key, so resolving `started` from
  inside it is the moment a repeat will find the key running.
- **Catch a rejection with `.then(onFulfilled, onRejected)`** where the
  promise is made, as above, and assert on the error it gives back: the
  rejection is handled from the start, whatever the test awaits before
  looking at it.
- The lease is renewed on a real timer while `work` runs, and `wait` sleeps
  between polls with real timers too. Keep a test's `work` short, or give the
  definition a `lease` well above how long the test holds it.

## Rate limits

```ts
const loginLimit = defineRateLimit({
	name: 'login',
	key: (p: { ip: string }) => p.ip,
	limit: 5,
	per: 60_000,
});

describe('the login limit', () => {
	const login = bindRateLimit(redis, loginLimit);
	const ip = { ip: '203.0.113.7' };

	test('allows five, then denies with a retryAfter', async () => {
		for (let i = 0; i < 5; i += 1) {
			expect((await login.consume(ip)).allowed).toBe(true);
		}
		const denied = await login.consume(ip);
		expect(denied.allowed).toBe(false);
		expect(denied.remaining).toBe(0);
		// The server's clock moved between calls: a range, not an exact number.
		expect(denied.retryAfter).toBeGreaterThan(11_000);
		expect(denied.retryAfter).toBeLessThanOrEqual(12_000);
	});

	test('moving the host clock refills nothing', async () => {
		for (let i = 0; i < 5; i += 1) await login.consume(ip);
		setSystemTime(new Date(Date.now() + 60 * 60_000)); // an hour ahead
		try {
			expect((await login.consume(ip)).allowed).toBe(false);
		} finally {
			setSystemTime();
		}
	});

	test('reset, not time, gives the bucket back', async () => {
		for (let i = 0; i < 5; i += 1) await login.consume(ip);
		expect(await login.reset(ip)).toBe(true);
		expect((await login.consume(ip)).remaining).toBe(4);
	});
});
```

- **Do not rely on the host's clock.** A bucket is timed by the Redis
  server's `TIME`, read inside the script, so `setSystemTime` — or any fake
  clock in your process — moves `Date.now()` and nothing else: the test above
  proves a spent limit stays spent an hour later by the host's reckoning.
- **Assert ranges on durations.** `retryAfter` and `resetAfter` are counted
  from the server's time at each call, and that time moves between two
  calls. `allowed` and `remaining` are exact.
- **To start from a full bucket, `reset` it** (or empty the database). To see
  a real refill, define a limit made for the test, with a short `per`, and
  wait out its `retryAfter`:

```ts
describe('a refill, on a limit made for the test', () => {
	const quick = bindRateLimit(
		redis,
		defineRateLimit({ name: 'quick', key: (id: string) => id, limit: 1, per: 200 }),
	);

	test('allows again once retryAfter has passed', async () => {
		await quick.consume('a');
		const denied = await quick.consume('a');
		expect(denied.allowed).toBe(false);
		await Bun.sleep(denied.retryAfter);
		expect((await quick.consume('a')).allowed).toBe(true);
	});
});
```

Waiting `retryAfter` is always enough: it is rounded up to the millisecond.
The [rate limits guide](rate-limits.md#what-the-numbers-mean) has what each
number means, and the [idempotency guide](idempotency.md#what-run-does) what
`run` answers in each state.

# Testing code that uses it

How to test your own rate limits and idempotent operations with `bun test`:
against which Redis, how to start each spec from nothing, and why moving the
clock does not refill a bucket.

The blocks on this page make one spec file, `guards.spec.ts`; paste them in
order. The Redis comes from `@nxgt/redis/testing`, whose optional peer is
installed as a devDependency:

```sh
bun add -d redis-memory-server
bun test guards.spec.ts
```

## A real Redis, one per suite

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	bindIdempotency,
	bindRateLimit,
	defineIdempotency,
	defineRateLimit,
	GuardError,
} from '@nxgt/redis';
import { startTestRedis, type TestRedis } from '@nxgt/redis/testing';

// A Redis of this file's own, on a free port: the version @nxgt/redis is
// tested against, built from source on a cold cache (see below).
const server: TestRedis = await startTestRedis();
const redis = new RedisClient(server.uri);

beforeEach(async () => {
	await server.reset(); // FLUSHALL
});

afterAll(async () => {
	redis.close();
	await server.stop();
});
```

- **Build Redis before the suite, not inside it.** Neither redis/redis nor
  valkey publishes a binary, so the first `startTestRedis` on a machine
  compiles the pinned version (`TEST_REDIS_VERSION`, 7.4.1): about two
  minutes, then 23 ms a start, cached in `downloadDir`
  (`node_modules/.cache/redis-memory-server` unless you pass one). Run
  `buildTestRedis()` from a script before `bun test` so that no hook's
  timeout covers the build, and cache that folder in CI:

  ```ts
  // test/redis.ts — "test": "bun run test/redis.ts && bun test"
  import { buildTestRedis } from '@nxgt/redis/testing';
  console.log(await buildTestRedis());
  ```

- **`$REDIS_BIN` skips the build**: when it names a `redis-server` — a system
  one, or a build kept from earlier — `startTestRedis` runs it, and
  `buildTestRedis` gives it back as it is. `{ binary }` does the same and
  wins over the variable.
- **`redis-memory-server` builds a Redis of its own on install** — the latest,
  by its postinstall, which Bun runs since the package is on its trusted list —
  and `startTestRedis` never uses it. `REDISMS_DISABLE_POSTINSTALL=1 bun install`
  skips it.
- **Against a Redis you already run**, skip the subpath: a
  `new RedisClient('redis://localhost:6379/15')` on a database nobody else
  uses, emptied with `FLUSHDB` rather than `FLUSHALL`, works the same way.
- **There is no mock to swap in.** Every check is a Lua script the server
  runs — sent with `EVALSHA`, or `EVAL` when the server does not hold it yet —
  and the rate-limit script reads the server's `TIME` inside it. A stub of
  `RedisClient` would have to run Lua. `@nxgt/redis` is tested against
  Redis 7.4.
- **Empty it before each test.** A bucket or an idempotency key left by one
  test changes what the next one sees: a limit already spent, a result
  replayed instead of run. `reset()` is `FLUSHALL`, safe on a server the
  suite owns; on a shared Redis, `FLUSHDB` empties only the database in the
  URL. To clear
  one key rather than everything, `reset(params)` refills a bucket and
  `forget(params)` deletes an idempotency key, running or done.
- **One client is enough for a spec.** `bindRateLimit` and `bindIdempotency` open no
  connection of their own — each takes yours — so closing yours is the only
  cleanup.

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

## A Redis that does not answer in time

To test what your code does with `TIMEOUT` — failing open, say — make the
server hold the guard's script: `CLIENT PAUSE <ms> WRITE`, sent from a
**second** client, holds every script that is not flagged read-only, `peek`
included, and runs them when the pause ends.

```ts
describe('a slow Redis', () => {
	const pauser = new RedisClient(server.uri);
	afterAll(() => pauser.close());

	test('consume rejects with TIMEOUT, and may still count', async () => {
		const login = bindRateLimit(redis, loginLimit);
		await pauser.send('CLIENT', ['PAUSE', '300', 'WRITE']);
		const error = await login.consume({ ip: '198.51.100.1' }, 1, { timeoutMs: 50 }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((error as GuardError).code).toBe('TIMEOUT');

		await redis.ping(); // answers once the held script ran: one client, in order
		expect((await login.peek({ ip: '198.51.100.1' }, 0)).remaining).toBe(4);
	});
});
```

- **The script runs once the pause ends**, so the cost is counted after all —
  the case your fail-open path has to live with. A `PING` on the same client
  answers only after it, which is why the spec sends one before it looks, and
  why a spec that gives up on a script should send one before the next
  test's `reset`.
- `CLIENT UNPAUSE` ends a pause early: put it in an `afterEach` if a test can
  fail while one is running.
The [rate limits guide](rate-limits.md#what-the-numbers-mean) has what each
number means, and the [idempotency guide](idempotency.md#what-run-does) what
`run` answers in each state.

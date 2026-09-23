# Rate limits

A rate limit says how often something may happen — five logins a minute per
address, ten exports a minute per user — and answers each attempt with
whether it is allowed, how much is left, and how long to wait.

```ts
import { RedisClient } from 'bun';
import { bindRateLimit, defineRateLimit } from '@nxgt/redis-guard';

export const loginLimit = defineRateLimit({
	name: 'login',
	key: (p: { ip: string }) => p.ip,
	limit: 5,
	per: 60_000,
});

const redis = new RedisClient(process.env.REDIS_URL);
const login = bindRateLimit(redis, loginLimit);

const result = await login.consume({ ip: '203.0.113.7' });
// { allowed: true, limit: 5, remaining: 4, resetAfter: 12000, retryAfter: 0 }
```

## Describing a limit

`defineRateLimit` describes; it talks to nothing, and gives back a frozen copy
you can export and share between modules. It throws a bare `TypeError` for a
definition that could never work, so a mistake stops the process at import
rather than at the first request.

| Field | |
| --- | --- |
| `name` | the key's prefix. Two limits must not share one |
| `key(params)` | the rest of the key, from whatever is limited. A function, so a renamed parameter is a compile error |
| `limit` | how many requests `per` allows, once refilled |
| `per` | the window, **in milliseconds** |
| `burst` | how many may arrive at once from a full bucket. Defaults to `limit` |

A stored key is `` `<name>:<key(params)>` `` — the same shape as an
`@nxgt/redis` cache's, so one naming scheme covers both:

```ts
login.keyFor({ ip: '203.0.113.7' });   // 'login:203.0.113.7'
```

`bindRateLimit(client, definition)` takes any Bun `RedisClient`: one you made,
or the `client` of an `@nxgt/redis` connection. It checks the definition
again, so one written by hand, without `defineRateLimit`, is refused the same
way — with `bindRateLimit` in the message instead.

## How it counts: GCRA

The algorithm is GCRA, the generic cell rate algorithm. Think of a bucket
that holds `burst` requests and refills one request every
`per ÷ limit` milliseconds — the **interval**.

Redis holds one string per key: the **theoretical arrival time** (TAT), the
moment the bucket would be full again. Each allowed request pushes it one
interval further (`cost` intervals, for a cost above 1). A request is allowed
while the TAT it would leave is no more than `burst` intervals ahead of now.

- **One script, one step.** Reading the TAT, deciding and writing it are one
  Lua script over one key, so two processes cannot both read the same TAT and
  both be allowed. Fifty concurrent calls from two connections against a
  burst of five allow exactly five — that is a spec.
- **The server's clock.** `now` is the Redis server's `TIME`, read inside the
  script. No host's clock is ever sent, so a host whose clock is a day wrong
  counts exactly like the others — also a spec.
- **A denial writes nothing.** Neither does `peek`. A caller hammering a spent
  limit does not push its own wait further out.
- **Nothing left behind.** The key expires when the bucket would be full
  again (`PX`, rounded up to the millisecond), so a limit nobody is using
  holds no key, and `resetAfter` is never shorter than the key's `PTTL`.
- **Loaded by its SHA-1.** The script is sent with `EVALSHA`; only when Redis
  answers `NOSCRIPT` — after a restart, a failover or a `SCRIPT FLUSH` — is
  the source sent with `EVAL`, which caches it again.

### What the numbers mean

| `LimitResult` | |
| --- | --- |
| `allowed` | whether this call was allowed — and, for `consume`, counted |
| `limit` | the burst: how many requests a full bucket holds |
| `remaining` | how many requests of cost 1 would be allowed now, after this one |
| `resetAfter` | milliseconds until the bucket is full again; `0` when it is |
| `retryAfter` | milliseconds until this call would be allowed; `0` when it was |

Every duration is a delay, rounded **up** to the millisecond: sleeping
`retryAfter` and trying again is always enough. None is a `Date` — a date
would be the server's time read on your host, and carry whatever the two
clocks disagree by.

For `limit: 5, per: 60_000`:

```ts
const ip = { ip: '203.0.113.7' };
await login.consume(ip);   // remaining 4, resetAfter 12000
await login.consume(ip);   // remaining 3, resetAfter 24000
// … three more, the last with remaining 0 …
await login.consume(ip);   // allowed false, remaining 0, retryAfter ≈ 12000
```

### Choosing `burst`

`burst` is how much may arrive at once; `limit` and `per` are the rate after.

```ts
// Ten exports a minute, but twenty at once is fine — a user who was away.
defineRateLimit({ name: 'export', key, limit: 10, per: 60_000, burst: 20 });

// Five logins a minute, never more than two back to back.
defineRateLimit({ name: 'login', key, limit: 5, per: 60_000, burst: 2 });
```

**GCRA is a rate, not a counter of fixed windows.** From a full bucket a
caller gets `burst` at once, then one every interval — so in the first `per`
it can make up to `burst + limit − 1` requests. For `limit: 5, per: 60_000`
that is 5 at once and 4 more at 12, 24, 36 and 48 s: 9 in the first minute,
then 5 a minute. A lower `burst` is how to hold the first minute down.

## Costs

A call can count for more than one request: an export of 500 rows, a batch of
five messages.

```ts
await exports.consume({ org, user }, 5);
```

`cost` is a whole number from 1 to the burst. A cost above the burst could
never be allowed — no bucket holds more — so it is refused rather than
denied forever. A cost that does not fit in what is left is **denied and
counts nothing**: with 2 remaining, `consume(params, 3)` is denied and 2 stay
remaining.

A cost is often computed from a request, so a refusal is a `GuardError` with
code `COST`, and the promise rejects — nothing is sent to Redis.

## Four ways to ask

```ts
const counted = await login.consume(params);   // counts it if allowed
const enforced = await login.enforce(params);  // counts it, or throws RATE_LIMITED
const peeked = await login.peek(params);       // what consume would say; counts nothing
const wasSet = await login.reset(params);      // refills the bucket
```

- `enforce` suits code where a denial is exceptional: a background job, an
  internal call. Its `GuardError` carries `retryAfter`.
- `peek(params, 0)` reads the bucket as it is — `remaining` and `resetAfter`
  — for a page that shows "3 attempts left" before anyone submits.
- `reset` is a support action — "unlock this account" — or the end of a
  successful login, when failed attempts are what you limit.

```ts
// Limit failed logins only.
const failures = bindRateLimit(redis, loginLimit);

const before = await failures.peek({ ip }, 1);
if (!before.allowed) return tooManyRequests(before.retryAfter);
if (await checkPassword(user, password)) {
	await failures.reset({ ip });
	return signIn(user);
}
await failures.consume({ ip });
return wrongPassword();
```

## HTTP: headers for any framework

A 429 should say when to come back. The recipe below turns a `LimitResult`
into headers; it is plain `Headers`, so it fits `Bun.serve`, Hono, Elysia or
anything that speaks the Fetch API.

```ts
import type { LimitResult } from '@nxgt/redis-guard';

/** The draft-standard RateLimit-* headers, and Retry-After on a denial. */
export function rateLimitHeaders(result: LimitResult): Headers {
	const headers = new Headers({
		'RateLimit-Limit': String(result.limit),
		'RateLimit-Remaining': String(result.remaining),
		'RateLimit-Reset': String(Math.ceil(result.resetAfter / 1000)),
	});
	if (!result.allowed) {
		headers.set('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
	}
	return headers;
}
```

- `Retry-After` and `RateLimit-Reset` are **seconds** in HTTP, and a delay,
  not a date — which is why they are `Math.ceil(ms / 1000)`: rounding down
  would tell a client to come back before it may.
- Both are delays already, so no clock is involved: the client counts from
  when it read the response.

With `Bun.serve`:

```ts
const login = bindRateLimit(redis, loginLimit);

Bun.serve({
	routes: {
		'/login': {
			async POST(request, server) {
				const ip = server.requestIP(request)?.address ?? 'unknown';
				const result = await login.consume({ ip });
				const headers = rateLimitHeaders(result);
				if (!result.allowed) {
					return new Response('Too many attempts', { status: 429, headers });
				}
				const response = await handleLogin(request);
				for (const [name, value] of headers) response.headers.set(name, value);
				return response;
			},
		},
	},
});
```

With Hono, the same as a middleware:

```ts
import { createMiddleware } from 'hono/factory';

export const limitLogins = createMiddleware(async (c, next) => {
	const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
	const result = await login.consume({ ip });
	for (const [name, value] of rateLimitHeaders(result)) c.header(name, value);
	if (!result.allowed) return c.text('Too many attempts', 429);
	await next();
});
```

Trust `x-forwarded-for` only behind a proxy you run: a client can send any
value, and each value is a fresh bucket.

With `enforce`, in an error handler:

```ts
app.onError((error, c) => {
	if (error instanceof GuardError && error.code === 'RATE_LIMITED') {
		c.header('Retry-After', String(Math.ceil((error.retryAfter ?? 0) / 1000)));
		return c.text('Too many requests', 429);
	}
	if (error instanceof GuardError && error.code === 'COST') {
		return c.text('That request is larger than this limit allows', 400);
	}
	throw error;
});
```

## Errors

| Code | When | Message |
| --- | --- | --- |
| `RATE_LIMITED` | `enforce` found the limit spent | `enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again` |
| `COST` | a cost outside 1 (0 for `peek`) to the burst | `consume on "login": a cost must be a whole number from 1 to the burst of 5` |

A `GuardError` names the **definition**, never the key or the params: those
came from a request — an address, a user id — and a log line is no place for
them. Every message, with its fix, is in
[troubleshooting](../troubleshooting.md).

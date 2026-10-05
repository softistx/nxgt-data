# Rate limits and idempotency

`redis.limits.<key>` and `redis.idempotency.<key>` are the application's
guards, already bound to the right client and already writing under the
deployment's prefix — the same wiring as [caches](caches.md), for the two
guards of [the guard guides](../guard/rate-limits.md).

```ts
// src/redis/limits.ts
import { defineRateLimit } from '@nxgt/redis';

export const login = defineRateLimit({
	name: 'login',
	key: (p: { ip: string }) => p.ip,
	limit: 5,
	per: 60_000,                       // milliseconds
});
```

```ts
// src/redis/idempotency.ts
import { defineIdempotency } from '@nxgt/redis';
import { z } from 'zod';

export const orders = defineIdempotency({
	name: 'orders.create',
	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
	ttl: 86_400,                       // seconds
	schema: z.object({ orderId: z.string(), status: z.string().default('placed') }),
});
```

```ts
// src/redis/index.ts
import { defineRedis, openRedis } from '@nxgt/redis';
import * as idempotency from './idempotency';
import * as limits from './limits';

export const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', limits, idempotency }),
);

// in a route
await redis.limits.login.enforce({ ip });                 // throws GuardError RATE_LIMITED
const { value, replayed } = await redis.idempotency.orders.run(
	{ user, key },
	() => placeOrder(body),
	{ fingerprint: rawBody },
);
```

The key is the name the definition is **exported** by, as for a cache, and
everything on it is [`BoundRateLimit`](../guard/rate-limits.md) or
[`BoundIdempotency`](../guard/idempotency.md), which is where the guards
themselves are described. Nothing is passed around: no client, no `bindRateLimit`
at a call site.

## The prefix, and moving from a guard bound by hand

A guard bound by hand, `bindRateLimit(client, login)`, writes `login:<ip>`. A
wired one writes the instance's prefix in front, like a cache does:

| | Bound by hand | Wired under `prefix: 'myapp:prod'` |
| --- | --- | --- |
| a rate limit `login` | `login:203.0.113.7` | `myapp:prod:login:203.0.113.7` |
| an idempotency `orders.create` | `orders.create:u1/k1` | `myapp:prod:orders.create:u1/k1` |

`keyFor` says the string, and `redis.instances.<name>.prefix` the prefix.

> **A trap when an application moves from by hand to wired.** The keys change,
> so what is stored under the old ones is **not seen any more**: every caller's
> rate-limit bucket starts full again, and an idempotency record written by the
> old code is not replayed — a retry of a request that ran just before the
> deploy runs **again**. With no `prefix` the keys are the same and nothing
> restarts. With one, expect it, and move at a quiet moment; the old keys
> expire by themselves (a limit's within `burst × per ÷ limit`, an idempotency
> record's within its `ttl`).

A `GuardError` from a wired guard names the prefixed definition, as a cache's
error does: `enforce on "myapp:prod:login": …`, and `error.definition` is
`myapp:prod:login`.

The definition is **copied** with the prefix in its name, never renamed: two
Redis objects can wire one definition under two prefixes and share no count and
no result.

```ts
const a = await openRedis(defineRedis({ uri, prefix: 'a', limits }));
const b = await openRedis(defineRedis({ uri, prefix: 'b', limits }));
// a.limits.login and b.limits.login each count on their own keys.
```

## What the wiring checks

- **Each slot keeps only its own kind**, as `caches` and `channels` do: a
  module that exports a cache, a rate limit and an idempotency can be passed as
  all of them — `defineRedis({ uri, caches: m, limits: m, idempotency: m })` —
  and every export is wired where it belongs. A definition under a slot of
  another kind is simply not wired there: `redis.limits.users` for a cache
  does not compile, and an instance left with nothing to wire is refused
  (`wires no cache, no channel, no rate limit and no idempotency`).
- **One definition under two keys is refused**, as for caches: `wires the rate
  limit named "login" twice, under …`, and `wires the idempotency named …`.
- **An instance that wires only guards is fine**; one that wires nothing at all
  is refused (`wires no cache, no channel, no rate limit and no idempotency`).
- **One name across a cache, a rate limit and an idempotency is refused.**
  All three write `<name>:<key>`, so a cache `login` and a rate limit `login`
  would meet in Redis (an idempotency's hash as a `WRONGTYPE`, the strings of a cache and a limit overwriting each other): `wires the cache "users" and the rate
  limit "login" under one name, "user". …`. The check compares **names** — a
  rename is the fix — runs at wiring time only, and does not include channels:
  pub/sub is another namespace.

Each message is in
[troubleshooting](../../troubleshooting.md#wiring-defineredis-and-openredis).

## What the types hold you to

```ts
redis.limits.nope;                                  // not wired: does not compile
await redis.limits.login.consume('10.0.0.1');       // keyed by { ip }, not a string
await redis.idempotency.orders.run(p, () => ({ id: 'x' }));  // not what the schema accepts
redis.limits.users;                                 // a cache is not wired on `limits`
```

With several instances `redis.limits` and `redis.idempotency` are `never`, as
`redis.cache` is: read `redis.instances.<name>.limits.login`.
`LimitScope`, `IdempotencyScope`, `SoleLimits` and `SoleIdempotency` are
exported for an application that names them.

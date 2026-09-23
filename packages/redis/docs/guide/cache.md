# Caches

A cached value described once — its key, how long it lives, and the shape it
holds — then bound to a client and used from anywhere.

## The smallest thing that works

```ts
import { z } from 'zod';
import { bindCache, connectRedis, defineCache } from '@nxgt/redis';

export const userCache = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 300, // seconds
	schema: z.object({ id: z.string(), email: z.string() }),
});

const redis = await connectRedis(process.env.REDIS_URL!);
const users = bindCache(redis.client, userCache);

await users.set('u1', { id: 'u1', email: 'ada@example.com' });
const found = await users.get('u1'); // { id: 'u1', email: 'ada@example.com' }
```

`defineCache` talks to nothing, so the definition is what a server, a worker
and a test share; `bindCache` is the half that needs a client. Getting one is
[Connections](connections.md).

## The signatures

```ts
import type { RedisClient } from 'bun';
import type { z } from 'zod';

interface CacheDefinition<P, S extends z.ZodType> {
	readonly name: string;
	readonly key: (params: P) => string;
	readonly ttl: number;
	readonly schema: S;
}

function defineCache<P, S extends z.ZodType>(
	definition: CacheDefinition<P, S>,
): CacheDefinition<P, S>;

function bindCache<P, S extends z.ZodType>(
	client: RedisClient,
	definition: CacheDefinition<P, S>,
): BoundCache<P, z.output<S>, z.input<S>>;

interface BoundCache<P, T, I = T> {
	keyFor(params: P): string;
	get(params: P): Promise<T | undefined>;
	set(params: P, value: I, options?: { ttl?: number }): Promise<void>;
	remember(
		params: P,
		load: () => Promise<I> | I,
		options?: { ttl?: number },
	): Promise<T>;
	delete(params: P): Promise<boolean>;
}
```

`T` is what the schema **gives back** — what `get` and `remember` return.
`I` is what it **accepts** — what `set` and a loader hand in. They differ
where the schema fills something in, a `.default()` above all:

```ts
const memberCache = defineCache({
	name: 'member',
	key: (id: string) => id,
	ttl: 300,
	schema: z.object({ id: z.string(), seats: z.number().default(1) }),
});
const members = bindCache(redis.client, memberCache);

await members.set('u1', { id: 'u1' });          // `seats` may be left out…
const member = await members.get('u1');         // …and is there: { id: 'u1', seats: 1 }
const loaded = await members.remember('u2', () => ({ id: 'u2' })); // seats: 1 too
```

What is stored is what the schema gave back, so every reader sees the
default, not only the one that wrote.

Where a field's input type is `unknown` — `z.coerce.number()` — the compiler
accepts any value for that field, though its key is still required; a whole
`z.preprocess` schema accepts anything. There `set` is checked at run time
only, by the schema, which refuses a wrong value with a `RedisError` before
anything is stored.

```ts
const countCache = defineCache({
	name: 'count',
	key: (id: string) => id,
	ttl: 60,
	schema: z.object({ n: z.coerce.number() }),
});
const counts = bindCache(redis.client, countCache);

await counts.set('u1', { n: '3' }); // compiles, and stores { n: 3 }
// await counts.set('u1', {});      // does not compile: `n` is still required
```

A value read back is not always one `set` accepts. Where a transform changes a
type, pass the input, not the output:

```ts
const seenCache = defineCache({
	name: 'seen',
	key: (id: string) => id,
	ttl: 60,
	schema: z.string().transform((s) => new Date(s)),
});
const seen = bindCache(redis.client, seenCache);

await seen.set('u1', '2026-09-22T10:00:00Z');       // the input: a string
const at = await seen.get('u1');                    // the output: a Date
// await seen.set('u1', at);                        // does not compile
```

## The definition

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | required | the key's prefix; a stored key is `` `<name>:<key(params)>` `` |
| `key` | `(params: P) => string` | required | the rest of the key, from whatever identifies the value |
| `ttl` | `number` | required | how long a value lives, **in seconds** — Redis's own unit for `EX` |
| `schema` | `z.ZodType` | required | what is stored, checked on the way in *and* on the way out |

The key is a **function**, not a template, so nothing is spelled by hand at a
call site and a renamed parameter is a compile error. `P` is whatever that
function takes — a string, or an object when more than one thing identifies
the value:

```ts
const seatCache = defineCache({
	name: 'seat',
	key: (p: { org: string; user: string }) => `${p.org}/${p.user}`,
	ttl: 60,
	schema: z.object({ taken: z.number() }),
});

bindCache(redis.client, seatCache).keyFor({ org: 'acme', user: 'u1' });
// 'seat:acme/u1'
```

`defineCache` refuses a definition that could never work, at import time:

```ts
defineCache({ name: '', key: (id: string) => id, ttl: 60, schema: z.string() });
// TypeError: defineCache: a cache needs a name, for its keys

defineCache({ name: 'x', key: (id: string) => id, ttl: 0, schema: z.string() });
// TypeError: defineCache: "x" has a ttl of 0; it is a number of seconds, …
```

The definition it gives back is frozen, so it cannot drift once it is shared.

## Reading and writing

```ts
await users.set('u1', { id: 'u1', email: 'ada@example.com' });
await users.set('u2', { id: 'u2', email: 'bob@example.com' }, { ttl: 5 });

await users.get('u1');    // the value
await users.get('nobody'); // undefined — a miss, an expiry, or a stale shape

await users.delete('u1'); // true when something was there
await users.delete('u1'); // false
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `ttl` (on `set` and `remember`) | `number` | the definition's `ttl` | seconds this one value lives |

A value is checked against the schema **before** it is stored, and a value
the schema refuses throws rather than being written:

```ts
import { RedisError } from '@nxgt/redis';

try {
	await users.set('u1', { id: 'u1', email: 42 } as never);
} catch (error) {
	if (error instanceof RedisError && error.code === 'INVALID') {
		// Nothing was written: a refused value is not a half-write.
	}
}
```

On the way **out** a value that no longer matches is not an error: it is
deleted and read as a miss, so an older deploy's shape can neither reach a
caller nor crash one. Anything that is not this package's JSON is a miss too.

```ts
await redis.client.set('user:u1', JSON.stringify({ id: 'u1' })); // an old shape
await users.get('u1'); // undefined, and the key is gone
```

## `remember`: load on a miss

```ts
const user = await users.remember('u1', () => loadUser('u1'));
```

The value if it is there, otherwise what `load` gives — stored, and given
back **as it was stored**. That last part matters when the schema has a
default, a transform, or unknown keys to strip: the caller that missed sees
exactly what every later caller sees.

```ts
const row = { id: 'u1', email: 'ada@example.com', role: 'admin' };
const missed = await users.remember('u1', () => row);
// { id: 'u1', email: 'ada@example.com' } — `role` is not in the schema
```

`remember` does **not** hold a lock: two callers missing at once both call
`load`, and the last value written is the one that stays. Where loading is
expensive or must happen once, wrap it in [a lock](locks.md):

```ts
import { withLock } from '@nxgt/redis';

const user = await users.remember('u1', () =>
	withLock(redis.client, 'user:u1:load', () => loadUser('u1'), {
		ttl: 60_000,
		wait: 10_000,
	}),
);
```

## A real one: a cached route

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { bindCache, connectRedis, defineCache } from '@nxgt/redis';

const profileCache = defineCache({
	name: 'profile',
	key: (p: { userId: string }) => p.userId,
	ttl: 120,
	schema: z.object({ id: z.string(), name: z.string() }),
});

const redis = await connectRedis(process.env.REDIS_URL!);
const profiles = bindCache(redis.client, profileCache);

const app = new Hono();

app.get('/users/:id/profile', async (c) => {
	const userId = c.req.param('id');
	const profile = await profiles.remember({ userId }, () =>
		fetchProfile(userId),
	);
	return c.json(profile);
});

app.put('/users/:id/profile', async (c) => {
	const userId = c.req.param('id');
	const profile = await saveProfile(userId, await c.req.json());
	await profiles.set({ userId }, profile); // write through, not delete
	return c.json(profile);
});
```

## Types a caller names

```ts
import type { BoundCache, InputOf, ParamsOf, ValueOf } from '@nxgt/redis';

type ProfileParams = ParamsOf<typeof profileCache>;   // { userId: string }
type Profile = ValueOf<typeof profileCache>;          // { id: string; name: string }
type ProfileInput = InputOf<typeof profileCache>;     // the same here: no default, no transform

function warm(
	cache: BoundCache<ProfileParams, Profile, ProfileInput>,
): Promise<void> {
	return cache.set({ userId: 'u1' }, { id: 'u1', name: 'Ada' });
}

await warm(profiles);
```

`ParamsOf` and `ValueOf` are there so a helper of your own can name what a
definition takes and what it holds without repeating either; `InputOf` is what
it accepts on a write — for a `.default()`, `ValueOf` with that field
optional; for a transform, the type before it. A
bound cache is `BoundCache<P, T, I>` — `I` defaults to `T` — so a helper can
take one without naming the definition it came from. Pass all three: a
two-argument `BoundCache<P, ValueOf<D>>` does not accept a cache whose
transform turns a string into a `Date`, since its `set` would then ask for a
`Date`.

## Errors

| `RedisErrorCode` | When |
| --- | --- |
| `INVALID` | a value being **written** does not match the schema |

`error.key` carries the key it happened on — never the value. A read never
raises `INVALID`: a stale shape is a miss. `defineCache`'s own refusals are
`TypeError`s, and they happen at definition time.

## Next

- [Connections](connections.md) — where `redis.client` comes from.
- [Locks](locks.md) — making a miss load once.
- [Pub/sub](channels.md) — telling other processes a cached thing changed.
- [Troubleshooting](../troubleshooting.md) — a value that keeps coming back
  `undefined`.

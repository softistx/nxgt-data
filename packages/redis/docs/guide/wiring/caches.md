# Caches

`redis.cache.<key>` is one of the application's caches, already bound to the
right client and already writing under the deployment's prefix.

```ts
import { openRedis, defineRedis } from '@nxgt/redis';
import * as caches from './caches';

const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', caches }),
);

const user = await redis.cache.users.remember('ada', () => loadUser('ada'));
```

The key is the name the definition is **exported** by — `export const users =
defineCache(…)` is `redis.cache.users` — and everything on it is
[`BoundCache`](../cache.md), which is where the caching itself is described. This page is about what the
wiring adds: the binding, the prefix, and what the types hold you to.

## What is on a cache

| Member | | |
| --- | --- | --- |
| `definition` | `CacheDefinition` | the definition it was bound with, read-only and frozen; its `name` carries the prefix, so `definition.ttl` is the policy and `definition.name` the name written |
| `keyFor(params)` | `string` | the key it would use, for a caller that needs the string itself |
| `get(params)` | `Promise<T \| undefined>` | the value, or `undefined` — a miss, an expiry, or a shape the schema no longer matches |
| `set(params, value, { ttl })` | `Promise<void>` | the value as the schema accepts it — a `.default()` field may be left out — checked, then stored as the schema gives it back, for the definition's `ttl` or the one given here |
| `remember(params, load, { ttl })` | `Promise<T>` | the value if it is there, otherwise what `load` gives — the value as the schema accepts it, its input — stored, and given back **as it was stored** |
| `delete(params)` | `Promise<boolean>` | `true` when something was there |

`params` is whatever the definition's `key` function takes, so a cache keyed
by an id takes a string and one keyed by a pair takes the object:

```ts
await redis.cache.users.get('ada');
await redis.cache.seats.get({ org: 'acme', user: 'ada' });
```

Both of those are compile errors the other way round. `ttl` is **seconds**
here — Redis's `EX` — while a lock's is milliseconds; see
[locks](locks-and-health.md).

## The keys it writes

```ts
redis.cache.users.keyFor('ada');           // 'myapp:prod:user:ada' with a prefix
redis.instances.default.prefix;            // 'myapp:prod', or undefined
```

A stored key is `` `<prefix>:<name>:<key(params)>` ``, and without a prefix
just `` `<name>:<key(params)>` ``. `keyFor` is the one place to read it from:
a key spelled by hand in a script drifts the first time the prefix changes.
The [configuration page](configuration.md#the-prefix) has the whole layout,
locks included.

## A value is written as the schema *accepts* it

```ts
const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),          // a default, on the way in
});

await redis.cache.users.set('ada', { id: 'ada', email: 'ada@example.com' });
const ada = await redis.cache.users.get('ada');
// { id: 'ada', email: 'ada@example.com', seats: 1 }
```

`set` and a `remember` loader take the value as the schema **accepts** it —
its `z.input` — and `get` and `remember` give it back as the schema
**produces** it — its `z.output`. A field with a `.default()` may be left out
where a value is written, and every reader gets it filled, since what is
stored is what the schema gave back. It is the same `BoundCache` as in the
[cache guide](../cache.md), typed through.

Where a field's input type is `unknown` — `z.coerce.number()` — the compiler
accepts any value for that field, though its key is still required; a whole
`z.preprocess` schema accepts anything. There the schema's own check when
`set` runs is what refuses a wrong value. Where a transform changes a type —
a string in, a `Date` out — a value read back is not one `set` accepts, and a
loader returns the input too; the
[troubleshooting](../../troubleshooting.md#types) page has the compile errors
and the fix.

## Built on first read, and kept

```ts
redis.cache.users === redis.cache.users;     // true
Object.keys(redis.cache);                  // ['seats', 'users'] — what is wired
(redis.cache as Record<string, unknown>).nope;   // undefined
```

Nothing is bound before the first read of its key: an application wires every
cache it has, and a request touches two of them. The scope is frozen, and it
is **not** a client with names on it — nothing falls through to a driver
member, so a key that is wired nowhere is plainly `undefined` rather than a
Redis command that happens to share the name.

## In a request

```ts
import { Hono } from 'hono';
import { redis } from './redis/redis';
import { loadUser, updateUser } from './users';

export const users = new Hono()
	.get('/users/:id', async (c) => {
		const id = c.req.param('id');
		const user = await redis.cache.users.remember(id, () => loadUser(id));
		return c.json(user);
	})
	.put('/users/:id', async (c) => {
		const id = c.req.param('id');
		const user = await updateUser(id, await c.req.json());
		await redis.cache.users.delete(id);            // the next read reloads
		await redis.channels.created.publish(user);    // and the other processes hear it
		return c.json(user);
	});
```

The object `openRedis` gives back is a module-level constant: it is the same for every request —
there is no actor to stamp and no session to carry, so it is never derived —
and the caches on it are shared, which is what makes the first read of a key
the only one that builds anything.

**`remember` holds no lock.** Two requests missing at the same instant both
call `load`, and the last value written is the one that stays. Where loading
is expensive or must happen once, wrap it:

```ts
const user = await redis.lock(`user:${id}`, () =>
	redis.cache.users.remember(id, () => loadUser(id)),
);
```

## What the types refuse

Each of these is a `@ts-expect-error` case in this package's type tests:

```ts
redis.cache.nope;                                   // not wired
await redis.cache.users.get({ id: 'ada' });         // keyed by a string
await redis.cache.seats.get('ada');                 // keyed by an object
await redis.cache.users.set('ada', { id: 'ada' });  // a missing field
await redis.cache.users.set('ada', { id: 'ada', email: 'a@b.c', admin: true });
redis.instances.pubsub.cache.users;                 // that instance wires no cache
```

## The types

```ts
type CacheScope<Ca> = {
	readonly [K in keyof CachesOf<Ca>]: BoundCache<
		ParamsOf<CachesOf<Ca>[K]>,
		ValueOf<CachesOf<Ca>[K]>,
		InputOf<CachesOf<Ca>[K]>
	>;
};

/** The caches of a module object, and nothing else. */
type CachesOf<C> = {
	[K in keyof C as C[K] extends CacheDefinition<never, z.ZodType> ? K : never]: C[K];
};
```

`CachesOf` is the key remapping that drops everything in the module that is
not a definition, which is why `import * as caches` can be passed as it is.
`BoundCache`, `ParamsOf`, `ValueOf` — what a read gives — and `InputOf` —
what a write takes — are described in the [cache guide](../cache.md).

Next: [channels](channels.md) for the events beside these values, or
[locks and health](locks-and-health.md) for the work a cache miss sometimes
starts.

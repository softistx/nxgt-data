# Caches

`kit.cache.<key>` is one of the application's caches, already bound to the
right client and already writing under the deployment's prefix.

```ts
import { connectKit, defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';

const kit = await connectKit(
	defineConfig({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', caches }),
);

const user = await kit.cache.users.remember('ada', () => loadUser('ada'));
```

The key is the name the definition is **exported** by — `export const users =
defineCache(…)` is `kit.cache.users` — and everything on it is
`@nxgt/redis`'s [`BoundCache`](https://www.npmjs.com/package/@nxgt/redis),
which is where the caching itself is described. This page is about what the
kit adds: the binding, the prefix, and what the types hold you to.

## What is on a cache

| Member | | |
| --- | --- | --- |
| `keyFor(params)` | `string` | the key it would use, for a caller that needs the string itself |
| `get(params)` | `Promise<T \| undefined>` | the value, or `undefined` — a miss, an expiry, or a shape the schema no longer matches |
| `set(params, value, { ttl })` | `Promise<void>` | checked against the schema first, then stored for the definition's `ttl` or the one given here |
| `remember(params, load, { ttl })` | `Promise<T>` | the value if it is there, otherwise what `load` gives — stored, and given back **as it was stored** |
| `delete(params)` | `Promise<boolean>` | `true` when something was there |

`params` is whatever the definition's `key` function takes, so a cache keyed
by an id takes a string and one keyed by a pair takes the object:

```ts
await kit.cache.users.get('ada');
await kit.cache.seats.get({ org: 'acme', user: 'ada' });
```

Both of those are compile errors the other way round. `ttl` is **seconds**
here — Redis's `EX` — while a lock's is milliseconds; see
[locks](locks-and-health.md).

## The keys it writes

```ts
kit.cache.users.keyFor('ada');           // 'myapp:prod:user:ada' with a prefix
kit.instances.default.prefix;            // 'myapp:prod', or undefined
```

A stored key is `` `<prefix>:<name>:<key(params)>` ``, and without a prefix
just `` `<name>:<key(params)>` ``. `keyFor` is the one place to read it from:
a key spelled by hand in a script drifts the first time the prefix changes.
The [configuration page](configuration.md#the-prefix) has the whole layout,
locks included.

## A value is written as the schema *outputs* it

```ts
const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),          // a default, on the way in
});

await kit.cache.users.set('ada', { id: 'ada', email: 'ada@example.com' });
// Argument of type '{ id: string; email: string; }' is not assignable to
// parameter of type '{ id: string; email: string; seats: number; }'.
```

`set` and `remember` take the value the schema **produces**, not the one it
accepts, so a field with a `.default()` has to be passed anyway — `seats: 1`
above — and a loader has to return it. That is `@nxgt/redis`'s signature, not
this package's; it is written down in [the roadmap](../roadmap.md) under
*Later*, where it belongs to the sibling.

## Built on first read, and kept

```ts
kit.cache.users === kit.cache.users;     // true
Object.keys(kit.cache);                  // ['seats', 'users'] — what is wired
(kit.cache as Record<string, unknown>).nope;   // undefined
```

Nothing is bound before the first read of its key: an application wires every
cache it has, and a request touches two of them. The scope is frozen, and it
is **not** a client with names on it — nothing falls through to a driver
member, so a key that is wired nowhere is plainly `undefined` rather than a
Redis command that happens to share the name.

## In a request

```ts
import { Hono } from 'hono';
import { kit } from './redis/kit';
import { loadUser, updateUser } from './users';

export const users = new Hono()
	.get('/users/:id', async (c) => {
		const id = c.req.param('id');
		const user = await kit.cache.users.remember(id, () => loadUser(id));
		return c.json(user);
	})
	.put('/users/:id', async (c) => {
		const id = c.req.param('id');
		const user = await updateUser(id, await c.req.json());
		await kit.cache.users.delete(id);            // the next read reloads
		await kit.channels.created.publish(user);    // and the other processes hear it
		return c.json(user);
	});
```

The kit is a module-level constant: it is the same object for every request —
there is no actor to stamp and no session to carry, so it is never derived —
and the caches on it are shared, which is what makes the first read of a key
the only one that builds anything.

**`remember` holds no lock.** Two requests missing at the same instant both
call `load`, and the last value written is the one that stays. Where loading
is expensive or must happen once, wrap it:

```ts
const user = await kit.lock(`user:${id}`, () =>
	kit.cache.users.remember(id, () => loadUser(id)),
);
```

## What the types refuse

Each of these is a `@ts-expect-error` case in this package's type tests:

```ts
kit.cache.nope;                                   // not wired
await kit.cache.users.get({ id: 'ada' });         // keyed by a string
await kit.cache.seats.get('ada');                 // keyed by an object
await kit.cache.users.set('ada', { id: 'ada' });  // a missing field
await kit.cache.users.set('ada', { id: 'ada', email: 'a@b.c', admin: true });
kit.instances.pubsub.cache.users;                 // that instance wires no cache
```

## The types

```ts
type CacheScope<Ca> = {
	readonly [K in keyof CachesOf<Ca>]: BoundCache<
		ParamsOf<CachesOf<Ca>[K]>,
		ValueOf<CachesOf<Ca>[K]>
	>;
};

/** The caches of a module object, and nothing else. */
type CachesOf<C> = {
	[K in keyof C as C[K] extends CacheDefinition<never, z.ZodType> ? K : never]: C[K];
};
```

`CachesOf` is the key remapping that drops everything in the module that is
not a definition, which is why `import * as caches` can be passed as it is.
`BoundCache`, `ParamsOf` and `ValueOf` are `@nxgt/redis`'s.

Next: [channels](channels.md) for the events beside these values, or
[locks and health](locks-and-health.md) for the work a cache miss sometimes
starts.

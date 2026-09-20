# Configuration

`defineConfig` describes an application's Redis — where it is, what is wired
on it, and which deployment owns the keys — and checks that description before
anything connects.

```ts
import { defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';
import * as channels from './channels';

export const config = defineConfig({
	uri: process.env.REDIS_URL!,
	prefix: 'myapp:prod',
	caches,
	channels,
});
```

It opens no socket and reads no environment variable of its own: the
application reads `process.env` where it reads its other settings, so this
package never has to explain which variable it looked at, and what is wrong
with the wiring throws here — where the application starts — rather than at
the first `get`. [`connectKit`](instances.md) is what connects.

## What gets wired

`caches` and `channels` are module objects, the ones `import * as` gives:

```ts
// src/redis/caches.ts
import { defineCache } from '@nxgt/redis';
import { z } from 'zod';

export const userSchema = z.object({ id: z.string(), email: z.string() });

/** Keyed by a plain id. */
export const users = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 300,                                    // seconds
	schema: userSchema,
});

/** Keyed by more than one thing, which is why `key` takes an object. */
export const seats = defineCache({
	name: 'seat',
	key: (params: { org: string; user: string }) => `${params.org}/${params.user}`,
	ttl: 60,
	schema: z.object({ taken: z.number() }),
});

/** Not a definition: the scope skips it rather than trip over it. */
export const CACHE_NOTE = 'exported beside the definitions, on purpose';
```

Every export that is a `defineCache` becomes a key on `kit.cache`, every
`defineChannel` a key on `kit.channels`, under the name it is **exported** by.
A schema, a type, a helper or a constant in the same file is left where it is,
so the module is passed as it is and nothing has to be filtered by hand.

A cache and a channel are told apart by shape, not by identity: a
`CacheDefinition` has a `ttl` and a `key` function, and `ChannelDefinition`
declares `ttl?: never` for exactly this reason. Both kinds may therefore be
exported from one file.

The key is what the application reads and the definition's own `name` is what
Redis holds, so they are free to differ:

```ts
export const users = defineCache({ name: 'app_user', /* … */ });
// kit.cache.users here, `app_user:ada` there.
```

**One definition exported under two keys is refused.** Both would write the
same Redis keys, so `kit.cache.b.delete(p)` would empty what
`kit.cache.a.set(p, v)` wrote, and nothing downstream could see it:

```
defineConfig: instance "default" wires the cache named "user" twice, under
"users" and "people". They would share every key in Redis. Export one of
them, or give it a name of its own.
```

Two *different* definitions that happen to agree on something else are fine —
the refusal is about one definition under two keys.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `uri` | `string` | — | Where to connect. One of `uri` and `client`, never both |
| `client` | `RedisClient` | — | A client the application opened. The kit uses it and **never closes it** |
| `clientOptions` | `RedisOptions` | `{}` | Bun's own options, passed to the driver with `uri`. Refused beside `client`, which was opened with its own |
| `prefix` | `string` | — | Put in front of every cache key, channel name and lock key this instance writes |
| `caches` | module object | — | `import * as caches from './caches'` |
| `channels` | module object | — | `import * as channels from './channels'` |
| `instances` | `Record<string, …>` | — | Several Redis instances, each taking the keys above. Written *instead* of them |

An instance needs a `uri` **or** a `client`, and wires at least one cache or
one channel — an instance with nothing on it is a leftover, not a
configuration. An option this table does not list does not compile.

### `client`: a Redis the application already opened

```ts
import { connectRedis } from '@nxgt/redis';
import { defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';

const redis = await connectRedis(process.env.REDIS_URL!);

export const config = defineConfig({ client: redis.client, caches });
```

The kit uses that client and never closes it, `await using` included: what it
did not open is not its to close. `clientOptions` beside it is refused — the
client was opened with its own.

## The prefix

```ts
defineConfig({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', caches });
```

| What | Without a prefix | With `prefix: 'myapp:prod'` |
| --- | --- | --- |
| a cache key | `user:ada` | `myapp:prod:user:ada` |
| a channel name | `user.created` | `myapp:prod:user.created` |
| a lock key | `lock:import` | `lock:myapp:prod:import` |

It belongs to the wiring and not to the definition, because a definition says
what a value *is* while a prefix says which deployment owns it — and one
definition, imported by a staging process and a production one, cannot know
that. One prefix covers the caches, the channels and the locks, so there is no
third place to remember.

On a lock it lands **inside** `lock:`: `@nxgt/redis`'s `withLock` writes
`` `lock:${key}` `` itself, and this package does not reach into a sibling to
reorder it. Two deployments are still kept apart, which is the point.

The definition is **copied**, never renamed, so two kits can wire one
definition under two prefixes — which is what a test that runs beside a
development Redis does:

```ts
const prod = await connectKit(defineConfig({ uri, prefix: 'prod', caches }));
const staging = await connectKit(defineConfig({ uri, prefix: 'staging', caches }));

await prod.cache.users.set('ada', { id: 'ada', email: 'p@example.com' });
await staging.cache.users.set('ada', { id: 'ada', email: 's@example.com' });
// two keys, two values, and `caches.users.name` is still 'user'.
```

An empty prefix is refused rather than quietly written as `:user:ada`.

## What it refuses

Every refusal is a bare `TypeError` naming the instance and what to do. There
is no error class: these all happen while an application is wiring itself, and
there are few enough to tell apart by their sentence.

| Configuration | Message |
| --- | --- |
| neither `uri` nor `client` | `has neither uri nor client. Give it one.` |
| both | `has both uri and client. Pass the URI to connect to, or the client you already opened.` |
| `clientOptions` beside `client` | `has clientOptions beside a client. …` |
| `prefix: '   '` | `has an empty prefix. Leave it out, or give it a name.` |
| nothing wired | `wires no cache and no channel. …` |
| one definition, two keys | `wires the cache named "user" twice, under … and …` |
| `instances: {}` | ``defineConfig: `instances` is empty. …`` |

Each one in full, with its fix, is in
[troubleshooting](../troubleshooting.md). The same checks run again in
`connectKit`: a configuration is often built in one file and connected in
another, and that call is the one a stack trace points at.

## Several Redis instances

```ts
export const config = defineConfig({
	instances: {
		cache: { uri: process.env.REDIS_URL!, prefix: 'myapp', caches },
		pubsub: { uri: process.env.EVENTS_URL!, prefix: 'myapp', channels },
	},
});
```

Each instance takes the same keys, and the names are what `kit.instances` and
`kit.ping()` are keyed by. A single instance written as the configuration
itself is named `default`, so everything below has one shape to handle —
[Instances and closing](instances.md) is the rest of that story.

## The signature

```ts
function defineConfig<const C extends KitConfigInput>(
	config: C & Checked<C>,
): KitConfig<C>;

type KitConfigInput =
	| InstanceConfig<object, object>
	| { instances: Record<string, InstanceConfig<object, object>> };

interface KitConfig<C> {
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceConfig<CachesIn<C, N>, ChannelsIn<C, N>>;
	};
}
```

The result is frozen, and always keyed: the single-instance shape is
normalised to `{ instances: { default: … } }`, which is why
`config.instances.default.uri` reads back whatever was written.

`Checked<C>` is the constraint that turns an unknown key into a message
instead of letting it through — `defineConfig` infers its argument, so a plain
object literal gets no excess-property check of its own, the literal *being*
the inferred type. It is internal, and nothing has to name it.

`KitConfig`, `KitConfigInput`, `InstanceConfig`, `InstanceName`,
`InstancesOf`, `CachesIn`, `ChannelsIn`, `CachesOf` and `ChannelsOf` are
exported for an application that writes its own helper over a configuration.

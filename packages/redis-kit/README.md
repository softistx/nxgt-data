# @nxgt/redis-kit

An application's Redis wiring in one object: a configuration checked once, the
clients it opens from it, and every cache and channel of
[`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis) typed under the key
it is wired as.

```ts
import { connectKit, defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';       // every `defineCache` of the app
import * as channels from './channels';   // every `defineChannel`

export const kit = await connectKit(
	defineConfig({
		uri: process.env.REDIS_URL!,
		prefix: 'myapp:prod',
		caches,
		channels,
	}),
);

const user = await kit.cache.users.remember(id, () => loadUser(id));
await kit.channels.created.publish(user);
await kit.lock('import', () => importEverything());
```

`kit.cache.users` is the bound cache `bindCache(client, users)` gives, and
`kit.channels.created` the same for a channel — each under the key its
definition is exported by, with the deployment's prefix already in front of
everything it writes. Nothing else has to be passed around: no client, no
`bindCache` at a call site, no prefix spelled by hand.

> **0.x, on `@nxgt/redis` 0.3.** The API is still settling.

## Install

```sh
bun add @nxgt/redis-kit @nxgt/redis zod
```

- `@nxgt/redis` `^0.3.0`: required peer. The caches, the channels and the lock
  are its; this package is where an application says which it has and where
  they live.
- `zod` `>=4.6.5 <5`: required peer, `@nxgt/redis`'s own — every value and
  every payload is described by a schema.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package pins.
- `@types/bun`: needed to typecheck. The shipped declarations name Bun's
  `RedisClient`, so without Bun's types the first `tsc` fails with
  `Cannot find module 'bun'`.
- **Bun 1.4 or later, and Bun only**: the client is Bun's own `RedisClient`,
  which is what makes `@nxgt/redis` install no driver. Tested against Redis
  7.4.

## The caches and the channels

They come from module objects — one `import * as` each, and every type
follows:

```ts
// src/redis/caches.ts
import { defineCache } from '@nxgt/redis';
import { z } from 'zod';

export const userSchema = z.object({ id: z.string(), email: z.string() });

export const users = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 300,                              // seconds
	schema: userSchema,
});
```

```ts
// src/redis/channels.ts
import { defineChannel } from '@nxgt/redis';
import { z } from 'zod';
import { userSchema } from './caches';

export const created = defineChannel({
	name: 'user.created',
	schema: userSchema,
});

export const deleted = defineChannel({
	name: 'user.deleted',
	schema: z.object({ id: z.string() }),
});
```

Every export that is a `defineCache` becomes a key on `kit.cache`, every
`defineChannel` a key on `kit.channels`, under the name it is **exported** by;
a schema, a type or a constant in the same file is left where it is. The key
is what the application reads (`kit.cache.users`), and the definition's own
`name` is what Redis holds (`user:ada`), so the two are free to differ. One
definition exported under two keys is refused: both would write the same keys,
and one of them would be silently dead.

**Two scopes, not one client with names on it.** A Redis client answers to a
hundred commands, so a cache called `get` and a channel called `subscribe`
would fight over it; here a cache and a channel may share a name without
either shadowing the other, nothing falls through to the driver, and a key
that is wired nowhere is plainly `undefined`. `Object.keys(kit.cache)` lists
exactly what is wired.

## The configuration

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

`defineConfig` **connects to nothing and reads no environment variable**: the
application writes `process.env.REDIS_URL!` where its other settings are read,
and what is wrong with the wiring throws here, where the application starts,
rather than at the first `get`. `connectKit` is what opens the clients — which
is also why it is not called `createKit`.

| Key | Default | |
| --- | --- | --- |
| `uri` | — | Where to connect. One of `uri` and `client`, never both |
| `client` | — | A client the application opened. **Never closed** by the kit |
| `clientOptions` | `{}` | Bun's `RedisOptions`, passed with `uri`. Refused beside `client` |
| `prefix` | — | Put in front of every key, channel and lock this instance writes |
| `caches` | — | `import * as caches from './caches'`, as it is |
| `channels` | — | `import * as channels from './channels'`, as it is |

Several Redis instances go under `instances: { … }`, each taking the same
keys. An instance that wires neither a cache nor a channel is refused, and so
is an empty prefix.

## The prefix

```ts
defineConfig({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', caches });
// kit.cache.users.keyFor('ada')  →  'myapp:prod:user:ada'
// kit.channels.created.name      →  'myapp:prod:user.created'
// kit.lock('import', work)       →  'lock:myapp:prod:import'
```

It belongs to the **wiring**, not to the definition: a definition says what a
value *is*, a prefix says which deployment owns it — and the same definition,
imported by a staging process and a production one, cannot know that. Two kits
may wire one definition under two prefixes; the definition itself is copied,
never renamed.

On a lock the prefix lands **inside** `lock:` — `lock:myapp:prod:import`,
where a cache key is `myapp:prod:user:ada`. `@nxgt/redis`'s `withLock` writes
`` `lock:${key}` `` itself, and this package does not reach into a sibling to
reorder it; two deployments are kept apart either way, which is what the
prefix is for.

## Caches

```ts
const user = await kit.cache.users.remember(id, () => loadUser(id));
await kit.cache.users.set(id, { id, email: 'ada@example.com' });
await kit.cache.users.delete(id);
const taken = await kit.cache.seats.get({ org: 'acme', user: id });   // keyed by an object
```

Every member is `@nxgt/redis`'s `BoundCache`: `keyFor`, `get`, `set`,
`remember`, `delete`, with the params its `key` function takes. A read —
`get`, `remember` — gives the schema's output; a write — `set`, `remember`'s
loader — takes its input, so a `.default()` field may be left out. A stored value that no longer matches the schema is a
miss, not an error. The bound cache is built the first time its key is read
and kept, so an application wires everything it has and pays for what a
request touches.

## Channels

```ts
const running = await kit.channels.created.subscribe(
	(user) => sendWelcome(user.email),   // typed by the channel's schema
	{ onError: (error, raw) => log.warn({ raw }, error) },
);

await kit.channels.created.publish(user);
await running.close();                   // or leave it to `kit.close()`
```

`publish` checks the payload against the schema and gives back the number of
subscribers Redis handed it to — not a delivery guarantee; pub/sub is
fire-and-forget. `subscribe` gives back `@nxgt/redis`'s `Subscription` with
its `close` replaced by one the kit hears — so closing it early works, and
`kit.close()` closes the ones nobody closed. Each one holds a connection
duplicated from the client, which is what a forgotten one costs.

## Locks and health

```ts
await kit.lock('import', () => importEverything(), {
	ttl: 60_000,                           // milliseconds the lock is held
	wait: 5_000,                           // milliseconds to keep trying
});

const health = await kit.ping();           // { default: { ok: true, latencyMs } }
```

`lock` is `@nxgt/redis`'s `withLock` on a key this instance's prefix is in
front of; it throws `RedisError` with `LOCK_HELD` when `wait` runs out and
`LOCK_LOST` when the work outran its `ttl`. `ping` answers within `timeoutMs`
(2 s by default) for every instance, under its name, and **never throws** — a
health route always has something to report.

## Several Redis instances

```ts
export const kit = await connectKit(
	defineConfig({
		instances: {
			cache: { uri: process.env.REDIS_URL!, prefix: 'myapp', caches },
			pubsub: { uri: process.env.EVENTS_URL!, prefix: 'myapp', channels },
		},
	}),
);

await kit.instances.cache.cache.users.get(id);
await kit.instances.pubsub.channels.created.publish(user);
await kit.lock('import', work, { on: 'cache' });
```

`kit.cache` and `kit.channels` are then `never` — the type, not a scope with
nothing on it — so `kit.cache.users` does not compile; reading either one
anyway, from JavaScript or across an `any`, throws with the names to use
instead. Naming one of two Redis instances by guessing is how a write lands on
the wrong one.

A single instance is named `default`, so `kit.instances.default` and
`kit.clients.default` are the long way of writing `kit.cache`'s instance. Two
instances on one URI share one client, which is what `connectRedis` already
does; their `clientOptions` must then be identical.

## Closing

```ts
await kit.close();                         // or `await using kit = await connectKit(…)`
```

It closes every subscription the kit started and then gives back the clients
it opened, in that order — a subscription holds a connection duplicated from
its client. It is idempotent, and it leaves alone a `client` the configuration
handed in: what it did not open is not its to close.

## Errors

There is no error class here. Every refusal this package makes is a bare
`TypeError` with a sentence that names the instance and what to do — they are
all wiring-time, and there are few enough to tell apart by reading them:

```
defineConfig: instance "default" has both uri and client. Pass the URI to
connect to, or the client you already opened.

kit.lock: this kit holds 2 Redis instances, and this call lives on one.
Name it, as { on: 'cache' }.
```

What a *call* throws is `@nxgt/redis`'s `RedisError`, unchanged: `INVALID` for
a value or a payload the schema refuses, `LOCK_HELD` and `LOCK_LOST` for a
lock. Redis's own failures come back from Bun's client as they are. Every
message, with the call that raises it, is in
[docs/troubleshooting.md](docs/troubleshooting.md).

## What does not compile

Each is a `@ts-expect-error` case in this package's type tests.

- `kit.cache.nope`, `kit.channels.nope`, or `kit.instances.nowhere`.
- A cache read or written with the wrong params — `users` is keyed by a
  string, `seats` by an object — or with a field its schema does not have.
- A payload a channel's schema does not describe, and a field a subscriber's
  handler reads that is not on it.
- `kit.cache` and `kit.channels` on a kit that holds several instances, and
  `{ on: 'nowhere' }` on `lock`.
- A cache read off an instance that wires only channels, and the reverse.
- An option the configuration does not have, and a `prefix` that is not a
  string.

## Traps

- **`defineConfig` connects to nothing**, so a wrong URI is `connectKit`'s
  error, not its. An instance that fails to open closes the ones already open
  before the error leaves.
- **A value is written as the schema *accepts* it**, so a field with a
  `.default()` may be left out of `set` and of `remember`'s loader. A
  `z.coerce.number()` field accepts any value, though its key is still
  required, and a whole `z.preprocess` schema accepts anything: there, `set`
  is checked at run time only, by the schema. Where a transform changes a
  type, a value read back does not compile as a write.
- **A subscription costs a connection.** Close it, or let `kit.close()` do it;
  one that outlives the kit is a socket nobody gives back.
- **`kit.cache` throws on a kit with several instances**, where its type is
  already `never`: the message names the instances to read instead.
- **A client the configuration handed in is never closed**, `await using`
  included. Close it where it was opened.
- **Two instances on one URI are one client**, so the second one's
  `clientOptions` must match the first's, or `connectRedis` refuses them.
- **The prefix is inside `lock:`** — `lock:myapp:import`, not
  `myapp:lock:import`. A key you read by hand has to be spelled that way.
- **A handler's error never reaches your caller.** It goes to `onError`, which
  writes to `console.error` unless you pass one.
- **Pub/sub loses what nobody is listening for.** `publish` reports how many
  subscribers Redis handed the message to, and nothing is stored or replayed.

## Documentation

- [Guide index](docs/README.md) — every page, and when to read it.
- [Configuration](docs/guide/configuration.md) — the instances, the modules
  they wire, and the prefix.
- [Caches](docs/guide/caches.md) — `kit.cache.<key>`, and what a request does
  with it.
- [Channels](docs/guide/channels.md) — `publish`, `subscribe`, and the
  subscriptions the kit keeps.
- [Locks and health](docs/guide/locks-and-health.md) — `kit.lock`, `kit.ping`
  and what they throw.
- [Instances and closing](docs/guide/instances.md) — several Redis instances,
  the shared client, and who closes what.
- [Troubleshooting](docs/troubleshooting.md) — the errors, by their message.
- [Roadmap](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT

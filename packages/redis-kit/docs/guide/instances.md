# Instances and closing

`connectKit` opens what a configuration describes and hands back the kit; this
page is about the object it hands back — one Redis or several — and about who
closes what.

```ts
import { connectKit, defineConfig } from '@nxgt/redis-kit';
import * as caches from './caches';
import * as channels from './channels';

export const kit = await connectKit(
	defineConfig({ uri: process.env.REDIS_URL!, caches, channels }),
);

await kit.cache.users.get('ada');
await kit.close();
```

`connectKit`, **not** `createKit`: across these packages a `create*` assembles
an object and does no I/O, and this call opens connections, so it takes the
verb that says so. [`defineConfig`](configuration.md) is the half that touches
nothing.

It checks the configuration again on its way through — a configuration is
often built in one file and connected in another, and this is the call a stack
trace points at — and if one instance fails to open, the ones already open are
closed before the error leaves.

## One Redis

A configuration written as a single instance is named `default`, so there is
one shape underneath and two ways to say the same thing:

```ts
kit.cache === kit.instances.default.cache;        // true
kit.channels === kit.instances.default.channels;  // true
kit.clients.default === kit.instances.default.client;  // true
```

`kit.cache` and `kit.channels` are the shortcut; the long way is always there,
and it is what a helper written over any kit uses.

## What is on an instance

| Member | | |
| --- | --- | --- |
| `cache` | `CacheScope` | the caches wired on this Redis, under their keys |
| `channels` | `ChannelScope` | the channels, likewise |
| `client` | `RedisClient` | Bun's own client, for a command this package does not wrap |
| `prefix` | `string \| undefined` | what goes in front of every key it writes |
| `lock(key, work, options?)` | `Promise<T>` | `withLock` on a key this instance's prefix is in front of |
| `ping(options?)` | `Promise<PingResult>` | answers within `timeoutMs`, and never throws |

```ts
await kit.instances.default.client.set('straight', 'through');
```

The client is untouched: everything `@nxgt/redis` does not wrap is still
there, and the kit makes no claim on commands it does not use.

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

await kit.instances.cache.cache.users.set('ada', { id: 'ada', email: 'a@b.c' });
await kit.instances.pubsub.channels.created.publish(user);
await kit.lock('import', work, { on: 'cache' });
const answered = await kit.ping();       // { cache: …, pubsub: … }
```

Each instance wires only what it was given: `kit.instances.pubsub.cache` is
empty, and reading a cache off it does not compile.

`kit.cache` and `kit.channels` are then **`never`** — the type itself, which
the package's type tests assign to `never` both ways — so `kit.cache.users`
does not compile; reading one anyway, from JavaScript or across an `any`,
throws:

```
kit.cache: this kit holds 2 Redis instances, and this call lives on one.
Name it, as { on: 'cache' }.
```

Naming one Redis out of two by guessing is how a write lands on the wrong one,
so nothing here picks the first. The same refusal covers `kit.lock` without
`{ on }`.

## One client per URI

```ts
kit.clients.cache === kit.clients.pubsub;   // true, when both name one URI
```

`connectRedis` shares one client per URI and counts its holders, so two
instances on one Redis are one socket, and it is given back when the last
holder lets go. Their `clientOptions` must then be identical — the second hold
on a client opened with other options is refused, and the message withholds
the URI, which may carry a password.

`kit.clients` is every client under its instance name, for a command that
belongs to no cache and no channel.

## Closing

```ts
await kit.close();
```

It closes every subscription the kit started, and then the clients it opened —
in that order, because a subscription holds a connection duplicated from its
client and unsubscribing on a closed one is an error nobody asked for. It is
**idempotent**, and `await using` calls it for you:

```ts
{
	await using kit = await connectKit(config);
	await kit.channels.created.subscribe(handler);
}   // the subscription, then the client
```

**A client the configuration handed in is never closed**, `await using`
included:

```ts
const redis = await connectRedis(process.env.REDIS_URL!);
const kit = await connectKit(defineConfig({ client: redis.client, caches }));

await kit.close();            // the kit is done…
await redis.client.set('still', 'here');   // …and the client is still yours
await redis.close();
```

What it did not open is not its to close. Nothing listens to `SIGTERM` for
you either: call `close()` where the process shuts down.

## In a test

```ts
import { afterAll, afterEach, expect, test } from 'bun:test';
import { connectKit, defineConfig } from '@nxgt/redis-kit';
import * as caches from '../src/redis/caches';

const kit = await connectKit(
	defineConfig({
		uri: process.env.REDIS_URL!,
		prefix: `test:${crypto.randomUUID()}`,
		caches,
	}),
);

afterAll(() => kit.close());
afterEach(() => kit.cache.users.delete('ada'));

test('remembers a user for the next read', async () => {
	const loaded = await kit.cache.users.remember('ada', () => ({
		id: 'ada',
		email: 'ada@example.com',
	}));
	expect(await kit.cache.users.get('ada')).toEqual(loaded);
});
```

A prefix of its own is what lets a suite share a Redis with anything else: the
definitions are copied under it, never renamed, so the application's module is
the same object in both.

Which is why the fixture deletes the keys it wrote rather than empty the
server: `FLUSHDB` takes every tenant the prefix was keeping apart — another
suite's, a development process's — and a `ttl` in seconds clears whatever a
test forgot soon enough. Where a file writes more than a key or two, track
what it wrote and delete that:

```ts
const written: string[] = [];

afterEach(async () => {
	for (const id of written.splice(0)) await kit.cache.users.delete(id);
});
```

## A service that holds the kit

```ts
// src/redis/kit.ts
export const kit = await connectKit(config);
export type Kit = typeof kit;

// src/users/service.ts
import type { Kit } from '../redis/kit';

export class Users {
	constructor(private readonly kit: Kit) {}

	async find(id: string) {
		return await this.kit.cache.users.remember(id, () => loadUser(id));
	}
}
```

`typeof kit` is the kit's type with every cache and channel on it; nothing has
to be spelled out for a constructor to take it.

Where the configuration and the kit live apart — a service typed in a module
that must not import the one that connects — `KitOf` writes the same type
from the configuration alone:

```ts
import type { KitOf } from '@nxgt/redis-kit';
import { config } from './redis/config';

export type Kit = KitOf<typeof config>;
```

The two are the same type. `typeof kit` is shorter wherever the kit is a
module constant; `KitOf` is what a package with no access to it uses.

## The signatures

```ts
function connectKit<C>(config: KitConfig<C>): Promise<RedisKit<C>>;

interface RedisKit<C> extends AsyncDisposable {
	readonly cache: SoleCache<C>;
	readonly channels: SoleChannels<C>;
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceScope<CachesIn<C, N>, ChannelsIn<C, N>>;
	};
	readonly clients: { readonly [N in InstanceName<C>]: RedisClient };
	lock<T>(key: string, work: () => Promise<T> | T, options?: KitLockOptions<C>): Promise<T>;
	ping(options?: { timeoutMs?: number }): Promise<Record<InstanceName<C>, PingResult>>;
	close(): Promise<void>;
}
```

There is **no `as(actor)` and no `withSession`**, as `@nxgt/mongo-kit` has:
Redis has neither an actor to stamp nor a session to carry, so a kit is the
same object for every request and is never derived. That is also why `close()`
always belongs to the kit you are holding.

`SoleInstance<C>` is the only instance's whole scope, and `SoleCache<C>` and
`SoleChannels<C>` are the two halves of it a kit puts at its top level; all
three are `never` when the kit holds more than one instance. `InstanceScope`,
`CacheScope`, `ChannelScope` and `BoundChannel` are exported for an
application that names them in its own signatures.

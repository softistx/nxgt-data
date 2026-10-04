# Instances and closing

`openRedis` opens what a configuration describes and hands back the `Redis`
object; this page is about it — one Redis or several — and about who
closes what.

```ts
import { openRedis, defineRedis } from '@nxgt/redis';
import * as caches from './caches';
import * as channels from './channels';

export const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, caches, channels }),
);

await redis.cache.users.get('ada');
await redis.close();
```

`openRedis`, not a `create*`: across these packages a `create*` assembles an
object and does no I/O, and this call opens connections, so it takes the verb
that says so. [`defineRedis`](configuration.md) is the half that touches
nothing.

It checks the configuration again on its way through — a configuration is
often built in one file and connected in another, and this is the call a stack
trace points at — and if one instance fails to open, the ones already open are
closed before the error leaves.

## One Redis

A configuration written as a single instance is named `default`, so there is
one shape underneath and two ways to say the same thing:

```ts
redis.cache === redis.instances.default.cache;        // true
redis.channels === redis.instances.default.channels;  // true
redis.clients.default === redis.instances.default.client;  // true
```

`redis.cache` and `redis.channels` are the shortcut; the long way is always
there, and it is what a helper written over any configuration uses.

## What is on an instance

| Member | | |
| --- | --- | --- |
| `cache` | `CacheScope` | the caches wired on this Redis, under their keys |
| `channels` | `ChannelScope` | the channels, likewise |
| `client` | `RedisClient` | Bun's own client, for a command the wiring does not wrap |
| `prefix` | `string \| undefined` | what goes in front of every key it writes |
| `lock(key, work, options?)` | `Promise<T>` | `withLock` on a key this instance's prefix is in front of |
| `ping(options?)` | `Promise<PingResult>` | answers within `timeoutMs`, and never throws |

```ts
await redis.instances.default.client.set('straight', 'through');
```

The client is untouched: everything this package does not wrap is still
there, and the wiring makes no claim on commands it does not use.

## Several Redis instances

```ts
export const redis = await openRedis(
	defineRedis({
		instances: {
			cache: { uri: process.env.REDIS_URL!, prefix: 'myapp', caches },
			pubsub: { uri: process.env.EVENTS_URL!, prefix: 'myapp', channels },
		},
	}),
);

await redis.instances.cache.cache.users.set('ada', { id: 'ada', email: 'a@b.c' });
await redis.instances.pubsub.channels.created.publish(user);
await redis.lock('import', work, { on: 'cache' });
const answered = await redis.ping();       // { cache: …, pubsub: … }
```

Each instance wires only what it was given: `redis.instances.pubsub.cache` is
empty, and reading a cache off it does not compile.

`redis.cache` and `redis.channels` are then **`never`** — the type itself, which
the type tests assign to `never` both ways — so `redis.cache.users`
does not compile; reading one anyway, from JavaScript or across an `any`,
throws:

```
cache: this Redis holds 2 Redis instances, and this call lives on one.
Name it, as { on: 'cache' }.
```

Naming one Redis out of two by guessing is how a write lands on the wrong one,
so nothing here picks the first. The same refusal covers `redis.lock` without
`{ on }`.

## One client per URI

```ts
redis.clients.cache === redis.clients.pubsub;   // true, when both name one URI
```

`connectRedis` shares one client per URI and counts its holders, so two
instances on one Redis are one socket, and it is given back when the last
holder lets go. Their `clientOptions` must then be identical — the second hold
on a client opened with other options is refused, and the message withholds
the URI, which may carry a password.

`redis.clients` is every client under its instance name, for a command that
belongs to no cache and no channel.

## Closing

```ts
await redis.close();
```

It closes every subscription it started, and then the clients it opened —
in that order, because a subscription holds a connection duplicated from its
client and unsubscribing on a closed one is an error nobody asked for. It is
**idempotent**, and `await using` calls it for you:

```ts
{
	await using redis = await openRedis(config);
	await redis.channels.created.subscribe(handler);
}   // the subscription, then the client
```

**A client the configuration handed in is never closed**, `await using`
included:

```ts
const connection = await connectRedis(process.env.REDIS_URL!);
const redis = await openRedis(defineRedis({ client: connection.client, caches }));

await redis.close();            // the wiring is done…
await connection.client.set('still', 'here');   // …and the client is still yours
await connection.close();
```

What it did not open is not its to close. Nothing listens to `SIGTERM` for
you either: call `close()` where the process shuts down.

## In a test

```ts
import { afterAll, afterEach, expect, test } from 'bun:test';
import { openRedis, defineRedis } from '@nxgt/redis';
import * as caches from '../src/redis/caches';

const redis = await openRedis(
	defineRedis({
		uri: process.env.REDIS_URL!,
		prefix: `test:${crypto.randomUUID()}`,
		caches,
	}),
);

afterAll(() => redis.close());
afterEach(() => redis.cache.users.delete('ada'));

test('remembers a user for the next read', async () => {
	const loaded = await redis.cache.users.remember('ada', () => ({
		id: 'ada',
		email: 'ada@example.com',
	}));
	expect(await redis.cache.users.get('ada')).toEqual(loaded);
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
	for (const id of written.splice(0)) await redis.cache.users.delete(id);
});
```

## A service that holds the Redis

```ts
// src/redis/redis.ts
export const redis = await openRedis(config);
export type Wiring = typeof redis;

// src/users/service.ts
import type { Wiring } from '../redis/redis';

export class Users {
	constructor(private readonly redis: Wiring) {}

	async find(id: string) {
		return await this.redis.cache.users.remember(id, () => loadUser(id));
	}
}
```

`typeof redis` is the type with every cache and channel on it; nothing has
to be spelled out for a constructor to take it.

Where the configuration and the connected object live apart — a service typed in a module
that must not import the one that connects — `RedisOf` writes the same type
from the configuration alone:

```ts
import type { RedisOf } from '@nxgt/redis';
import { config } from './redis/config';

export type Wiring = RedisOf<typeof config>;
```

The two are the same type. `typeof redis` is shorter wherever the object is a
module constant; `RedisOf` is what code with no access to it uses.

## The signatures

```ts
function openRedis<C>(config: RedisConfig<C>): Promise<Redis<C>>;

interface Redis<C> extends AsyncDisposable {
	readonly cache: SoleCache<C>;
	readonly channels: SoleChannels<C>;
	readonly instances: {
		readonly [N in InstanceName<C>]: InstanceScope<CachesIn<C, N>, ChannelsIn<C, N>>;
	};
	readonly clients: { readonly [N in InstanceName<C>]: RedisClient };
	lock<T>(key: string, work: () => Promise<T> | T, options?: RedisLockOptions<C>): Promise<T>;
	ping(options?: { timeoutMs?: number }): Promise<Record<InstanceName<C>, PingResult>>;
	close(): Promise<void>;
}
```

There is **no `as(actor)` and no `withSession`**, as `@nxgt/mongo-kit` has:
Redis has neither an actor to stamp nor a session to carry, so the object is the
same for every request and is never derived. That is also why `close()`
always belongs to the one you are holding.

`SoleInstance<C>` is the only instance's whole scope, and `SoleCache<C>` and
`SoleChannels<C>` are the two halves of it put at the top level; all three are
`never` when it holds more than one instance. `InstanceScope`,
`CacheScope`, `ChannelScope` and `BoundChannel` are exported for an
application that names them in its own signatures.

# Channels

`redis.channels.<key>` is one of the application's channels, bound to the right
client, carrying the deployment's prefix in its name, and handing back
subscriptions it will close if nobody else does.

```ts
import { openRedis, defineRedis } from '@nxgt/redis';
import * as channels from './channels';

const redis = await openRedis(
	defineRedis({ uri: process.env.REDIS_URL!, prefix: 'myapp:prod', channels }),
);

await redis.channels.created.subscribe((user) => sendWelcome(user.email));
await redis.channels.created.publish({ id: 'ada', email: 'ada@example.com' });
```

The key is the name the definition is **exported** by, and the payload is
typed by the schema it was defined with — in the handler as much as at the
`publish`. Pub/sub itself is described in the [channels guide](../channels.md); this
page is about what the wiring adds.

## What is on a channel

| Member | | |
| --- | --- | --- |
| `name` | `string` | the channel's name in Redis, prefix included — `myapp:prod:user.created` |
| `publish(payload)` | `Promise<number>` | checks the payload against the schema, publishes it, and gives back the number of subscribers Redis handed it to |
| `subscribe(handler, options?)` | `Promise<Subscription>` | listens, each message parsed by the schema, and records the subscription |

`publish`'s number is **not** a delivery guarantee: Redis pub/sub is
fire-and-forget, a subscriber that is not connected at that instant never sees
the message, and nothing is stored or replayed.

| `SubscribeOptions` | Type | Default | Effect |
| --- | --- | --- | --- |
| `onError` | `(error: unknown, raw: string) => void` | `console.error` | called **instead of** the handler for a message the schema refuses, and for an error the handler throws |

```ts
await redis.channels.created.subscribe(
	(user) => sendWelcome(user.email),
	{ onError: (error, raw) => log.warn({ channel: 'user.created', raw }, error) },
);
```

A handler's error has nowhere else to go — nobody is awaiting it — and Bun
ends the process on an unhandled rejection, so it is reported rather than
dropped.

## The subscriptions it keeps

```ts
const running = await redis.channels.created.subscribe(handler);
// …
await running.close();            // early, by the caller

await redis.close();                // or later, for the ones nobody closed
```

`subscribe` records the subscription — so `redis.close()` closes whatever is
left — and gives back the plain `Subscription` of [`subscribe`](../channels.md)
with `close` and `Symbol.asyncDispose` replaced by ones that tell the wiring
first. Everything else on it, `channel` included, is the original's: the copy is
built with `Object.create` over it rather than a spread, so a member added
later is not frozen into a snapshot. A subscription is therefore closed early,
or held with `await using`, exactly as it would be without the wiring.

Each subscription holds a connection **duplicated** from the client, because a
subscriber connection can run no other command; that is what a forgotten one
costs, and why the wiring tracks them at all.

Closing twice is safe: the wiring forgets a subscription the caller closed, and
the subscription's own `close` is memoised.

```ts
{
	await using redis = await openRedis(config);
	await redis.channels.created.subscribe(handler);
	await redis.channels.created.publish(user);
}   // the subscription and the client are given back here
```

## The name a message actually lands on

```ts
redis.channels.created.name;        // 'myapp:prod:user.created'
```

The prefix reaches Redis, it is not a label: a plain subscriber on
`myapp:prod:user.created` — through the raw client, or in another process —
receives what `redis.channels.created.publish(…)` sends. Without a prefix the
name is the definition's own. The whole layout is on the
[configuration page](configuration.md#the-prefix).

Two channels never hear each other, whatever their schemas have in common,
and a cache may carry the same key as a channel: `redis.cache` and
`redis.channels` are two scopes.

## A listener a process starts and stops

```ts
// src/redis/listeners.ts
import { redis } from './redis';

export async function startListeners() {
	await redis.channels.created.subscribe(async (user) => {
		await sendWelcome(user.email);
	});
	await redis.channels.deleted.subscribe(async ({ id }) => {
		await redis.cache.users.delete(id);
	});
}

// src/index.ts
await startListeners();
process.on('SIGTERM', () => {
	void redis.close();                // closes both, then the client
});
```

Nothing listens to a signal for you. `redis.close()` closes the subscriptions
first and the clients after, in that order: unsubscribing on a closed client
is an error nobody asked for.

In a **test**, the same thing in two lines:

```ts
import { afterAll, expect, test } from 'bun:test';

const redis = await openRedis(defineRedis({ uri, prefix: 'test', channels }));
afterAll(() => redis.close());

test('publishes what the schema describes', async () => {
	const seen: unknown[] = [];
	await redis.channels.created.subscribe((user) => void seen.push(user));
	await redis.channels.created.publish({ id: 'ada', email: 'ada@example.com' });
	// pub/sub is asynchronous: poll, do not assert on the next line.
	await Bun.sleep(50);
	expect(seen).toHaveLength(1);
});
```

## What a refused payload throws

```ts
import { RedisError } from '@nxgt/redis';

try {
	await redis.channels.deleted.publish({ id: 42 } as never);
} catch (error) {
	if (error instanceof RedisError && error.code === 'INVALID') {
		// 'This message does not match the schema "myapp:prod:user.deleted" carries: …'
	}
}
```

A payload the schema refuses is a `RedisError`, with the code
`INVALID` and the channel as its `key` — the wiring adds no error of its own. On
the way *in*, a message that does not parse goes to `onError` instead: a
publisher on an older deploy is not the subscriber's crash.

## What the types refuse

```ts
redis.channels.nope;                                // not wired
await redis.channels.created.publish({ id: 'ada' }); // the schema carries a user
await redis.channels.created.subscribe((payload) => {
	payload.admin;                                 // not a field of the schema
});
redis.instances.cache.channels.created;             // that instance wires no channel
```

## The types

```ts
interface BoundChannel<D> {
	readonly name: string;
	publish(payload: PayloadOf<D>): Promise<number>;
	subscribe(
		handler: (payload: PayloadOf<D>) => void | Promise<void>,
		options?: SubscribeOptions,
	): Promise<Subscription>;
}

/** What a channel carries, read from the schema it was defined with. */
type PayloadOf<D> = D extends ChannelDefinition<infer S> ? z.output<S> : never;

type ChannelScope<Ch> = {
	readonly [K in keyof ChannelsOf<Ch>]: BoundChannel<ChannelsOf<Ch>[K]>;
};
```

`PayloadOf` is what an application names when a handler lives somewhere else:

```ts
import type { PayloadOf } from '@nxgt/redis';
import type * as channels from './channels';

export async function sendWelcome(user: PayloadOf<typeof channels.created>) {
	// …
}
```

Next: [caches](caches.md) for the values these events usually invalidate, or
[instances and closing](instances.md) when the channels live on a Redis of
their own.

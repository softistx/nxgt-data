# Pub/sub

Telling other processes that something happened, with the payload described
by a schema on both ends.

## The smallest thing that works

```ts
import { z } from 'zod';
import { connectRedis, defineChannel, publish, subscribe } from '@nxgt/redis';

export const userCreated = defineChannel({
	name: 'user.created',
	schema: z.object({ id: z.string(), email: z.string() }),
});

const redis = await connectRedis(process.env.REDIS_URL!);

await using running = await subscribe(redis.client, userCreated, (user) => {
	console.log('welcome', user.email); // typed by the schema
});

await publish(redis.client, userCreated, {
	id: 'u1',
	email: 'ada@example.com',
});
```

`defineChannel` talks to nothing, so the same definition is imported by the
publisher and by the subscriber and neither spells the channel's name.

## The signatures

```ts
import type { RedisClient } from 'bun';
import type { z } from 'zod';

interface ChannelDefinition<S extends z.ZodType> {
	readonly name: string;
	readonly schema: S;
	readonly ttl?: never;
}

function defineChannel<S extends z.ZodType>(
	definition: ChannelDefinition<S>,
): ChannelDefinition<S>;

function publish<S extends z.ZodType>(
	client: RedisClient,
	channel: ChannelDefinition<S>,
	payload: z.output<S>,
): Promise<number>;

function subscribe<S extends z.ZodType>(
	client: RedisClient,
	channel: ChannelDefinition<S>,
	handler: (payload: z.output<S>) => void | Promise<void>,
	options?: SubscribeOptions,
): Promise<Subscription>;

interface SubscribeOptions {
	onError?: (error: unknown, raw: string) => void;
}

interface Subscription extends AsyncDisposable {
	readonly channel: string;
	close(): Promise<void>;
}
```

`ttl?: never` on a definition is not decoration: a
[`CacheDefinition`](cache.md) is otherwise structurally a channel — same
`name`, same `schema` — and `publish(client, someCache, …)` would compile and
publish on a channel named after the cache. That line is what refuses it.

## Publishing

```ts
const handed = await publish(redis.client, userCreated, user);
// how many subscribers Redis handed the message to — 0 when nobody listens
```

The payload is checked against the schema **before** it is published:

```ts
import { RedisError } from '@nxgt/redis';

try {
	await publish(redis.client, userCreated, { id: 'u1' } as never);
} catch (error) {
	if (error instanceof RedisError && error.code === 'INVALID') {
		// Nothing was published.
	}
}
```

The number that comes back is **not a delivery guarantee**. Redis pub/sub is
fire-and-forget: a subscriber that is not connected at that instant never
sees the message, and nothing is replayed. Where a message must not be lost,
a stream or a queue is the right tool, not this.

## Subscribing

```ts
const running = await subscribe(
	redis.client,
	userCreated,
	async (user) => {
		await sendWelcome(user.email);
	},
	{ onError: (error, raw) => console.warn('dropped', raw, error) },
);

running.channel; // 'user.created'
await running.close(); // idempotent
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `onError` | `(error: unknown, raw: string) => void` | writes to `console.error` | called **instead of** the handler for a message that does not match the schema, and after a handler that throws. `raw` is the message as it arrived |

`onError` is the only place a handler's failure can go: a listener runs with
nobody to await it, and Bun ends the process on an unhandled rejection. Two
things reach it:

```ts
const errors: unknown[] = [];

await using _running = await subscribe(
	redis.client,
	userCreated,
	() => {
		throw new Error('handler failed');
	},
	{ onError: (error) => errors.push(error) },
);
// A message another service published under an older shape arrives here as
// a `RedisError` with code 'INVALID'; the handler above never runs for it.
```

An `onError` that throws is caught too, and reported to `console.error`: the
last resort cannot be allowed to end the process either.

`subscribe` **duplicates** the client, because a subscriber connection can
run no other command — Redis's own rule. `close()` gives that copy back; the
client you passed in is untouched and is still the one to `publish` with.
Each subscription is one more connection, so close them.

```ts
await using running = await subscribe(redis.client, userCreated, handle);
// closed at the end of the scope
```

## A real one: a worker beside a server

The definition, shared:

```ts
// events.ts
import { z } from 'zod';
import { defineChannel } from '@nxgt/redis';

export const userCreated = defineChannel({
	name: 'user.created',
	schema: z.object({ id: z.string(), email: z.string() }),
});
```

The server, publishing after a write:

```ts
import { Hono } from 'hono';
import { connectRedis, publish } from '@nxgt/redis';
import { userCreated } from './events';

const redis = await connectRedis(process.env.REDIS_URL!);
const app = new Hono();

app.post('/users', async (c) => {
	const user = await createUser(await c.req.json());
	await publish(redis.client, userCreated, user);
	return c.json(user, 201);
});
```

The worker, reacting:

```ts
import { closeRedis, connectRedis, subscribe } from '@nxgt/redis';
import { userCreated } from './events';

const redis = await connectRedis(process.env.REDIS_URL!);

const running = await subscribe(
	redis.client,
	userCreated,
	async (user) => {
		await sendWelcome(user.email);
	},
	{ onError: (error, raw) => console.error('user.created dropped', raw, error) },
);

process.on('SIGTERM', () => {
	void running.close().then(() => closeRedis());
});
```

## Errors

| `RedisErrorCode` | When | Where it surfaces |
| --- | --- | --- |
| `INVALID` | a payload does not match the channel's schema | thrown by `publish`; handed to `onError` on the subscribing side |

`error.key` is the channel's name. `defineChannel` refuses an empty name with
a `TypeError`, at definition time.

## Next

- [Connections](connections.md) — one client per URI, and what `close()`
  means for a subscription.
- [Caches](cache.md) — the same `define`/`bind` shape for stored values.
- [Troubleshooting](../troubleshooting.md) — a message nobody received.

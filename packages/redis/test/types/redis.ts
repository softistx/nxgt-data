// What this package refuses. Checked by `tsc --noEmit`, never run: a refusal
// that stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	bindCache,
	defineCache,
	defineChannel,
	publish,
	subscribe,
	withLock,
} from '../../src';
import { seatCache, userCache, userCreated } from '../fixtures';

const client = new RedisClient('redis://127.0.0.1:1');
const users = bindCache(client, userCache);
const seats = bindCache(client, seatCache);

const ada = { id: 'u1', email: 'ada@example.com', seats: 1 };

// The value is typed by the schema, and what comes back is too.
const found: Promise<typeof ada | undefined> = users.get('u1');
void found;

// @ts-expect-error the key is built from a string, not a number
users.get(1);

// @ts-expect-error this cache's key is built from an object
seats.keyFor('acme/u1');

// @ts-expect-error `org` is part of the key
seats.keyFor({ user: 'u1' });

// @ts-expect-error `email` is a string
users.set('u1', { id: 'u1', email: 42, seats: 1 });

// @ts-expect-error `id` is not optional
users.set('u1', { email: 'a@b.c', seats: 1 });

// @ts-expect-error a loader gives the cache's own shape
users.remember('u1', () => ({ id: 'u1' }));

// The loader may be synchronous or not; both give the schema's shape.
const remembered: Promise<typeof ada> = users.remember('u1', async () => ada);
void remembered;

defineCache({
	name: 'x',
	key: (id: string) => id,
	// @ts-expect-error `ttl` is a number of seconds
	ttl: '60',
	schema: z.string(),
});

defineCache({
	name: 'x',
	// @ts-expect-error a key is a string; Redis has no other kind
	key: (id: string) => id.length,
	ttl: 60,
	schema: z.string(),
});

// @ts-expect-error a cache needs a schema: nothing is stored unchecked
defineCache({ name: 'x', key: (id: string) => id, ttl: 60 });

// A channel's payload is typed by its schema, both ways.
void publish(client, userCreated, ada);

// @ts-expect-error `seats` is a number
void publish(client, userCreated, { id: 'u1', email: 'a@b.c', seats: 'one' });

// @ts-expect-error the payload is not a string
void publish(client, userCreated, 'u1');

void subscribe(client, userCreated, (user) => {
	const email: string = user.email;
	const seatCount: number = user.seats;
	void email;
	void seatCount;
});

void subscribe(client, userCreated, (user) => {
	// @ts-expect-error `name` is not on this channel's payload
	void user.name;
});

// @ts-expect-error a channel needs a name
defineChannel({ schema: z.string() });

// @ts-expect-error a channel needs a schema: nothing is published unchecked
defineChannel({ name: 'x' });

// @ts-expect-error a channel is not a cache
bindCache(client, userCreated);

// @ts-expect-error a cache is not a channel
void publish(client, userCache, ada);

// The work's own type is what `withLock` gives back.
const held: Promise<number> = withLock(client, 'job', () => 42);
void held;

// @ts-expect-error `ttl` is milliseconds, a number
void withLock(client, 'job', () => 42, { ttl: '30s' });

// @ts-expect-error there is no such option
void withLock(client, 'job', () => 42, { timeout: 30 });

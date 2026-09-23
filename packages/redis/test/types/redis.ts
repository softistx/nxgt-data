// What this package refuses. Checked by `tsc --noEmit`, never run: a refusal
// that stops holding fails the typecheck on its unused directive.
import { RedisClient } from 'bun';
import { z } from 'zod';
import {
	type BoundCache,
	bindCache,
	defineCache,
	defineChannel,
	type InputOf,
	type ParamsOf,
	publish,
	subscribe,
	type ValueOf,
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

// A field with a `.default()` may be left out where a value is written…
users.set('u1', { id: 'u1', email: 'a@b.c' });
const filled = users.remember('u1', () => ({ id: 'u1', email: 'a@b.c' }));
// …and is always there where one is read.
const seatsRead: Promise<number> = filled.then((user) => user.seats);
void seatsRead;
const inputSeats: InputOf<typeof userCache>['seats'] = undefined;
void inputSeats;
// @ts-expect-error what is read always has `seats`
const outputSeats: ValueOf<typeof userCache>['seats'] = undefined;
void outputSeats;

// A transform that changes a type: a value is written as the string the
// schema accepts, and read back as the Date it gives.
const stampCache = defineCache({
	name: 'stamp',
	key: (id: string) => id,
	schema: z.string().transform((s) => new Date(s)),
	ttl: 60,
});
const stamps = bindCache(client, stampCache);
stamps.set('s1', '2026-09-22T00:00:00Z');
const stampRead: Promise<Date | undefined> = stamps.get('s1');
void stampRead;
// @ts-expect-error what `get` gave is the output: `set` takes the input
stamps.set('s1', new Date());
// @ts-expect-error a loader returns what the schema accepts, not what it gives
stamps.remember('s1', async () => stampCache.schema.parse('2026-09-22'));
// @ts-expect-error a two-argument annotation drops the input: name it with InputOf
const oldStyle: BoundCache<string, ValueOf<typeof stampCache>> = stamps;
void oldStyle;
const named: BoundCache<
	string,
	ValueOf<typeof stampCache>,
	InputOf<typeof stampCache>
> = stamps;
void named;

// Where input and output overlap, the old annotation still compiles: method
// parameters are bivariant. Only the read value passed to `set` is refused.
const blankCache = defineCache({
	name: 'blank',
	key: (id: string) => id,
	schema: z.string().transform((s) => (s === '' ? null : s)),
	ttl: 60,
});
const blanks = bindCache(client, blankCache);
const loose: BoundCache<string, ValueOf<typeof blankCache>> = blanks;
void loose;
// @ts-expect-error `null` is what it gives, not what it accepts
blanks.set('b1', null);

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

// `ValueOf` resolves whatever the key takes. It used to be `never` for every
// definition but one whose key took `unknown`: `key` makes the definition
// contravariant in its parameters, so `CacheDefinition<string, …>` is not
// assignable to `CacheDefinition<unknown, …>` under `strictFunctionTypes`.
// One case per key shape, because that is what the mistake turned on.
const fromPlainKey: ValueOf<typeof userCache> = ada;
void fromPlainKey;

const fromObjectKey: ValueOf<typeof seatCache> = { taken: 1 };
void fromObjectKey;

// @ts-expect-error the seat cache holds `{ taken: number }`, not a user
const wrongValue: ValueOf<typeof seatCache> = ada;
void wrongValue;

// `ParamsOf` answers each key's own parameters, and refuses the other's.
const plainParams: ParamsOf<typeof userCache> = 'u1';
void plainParams;

const objectParams: ParamsOf<typeof seatCache> = { org: 'o1', user: 'u1' };
void objectParams;

// @ts-expect-error this key takes an object, not a string
const wrongParams: ParamsOf<typeof seatCache> = 'u1';
void wrongParams;

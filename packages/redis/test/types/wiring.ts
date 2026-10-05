/**
 * What the types refuse. Checked by `tsc --noEmit`, never run.
 *
 * A `@ts-expect-error` that stops being an error fails the build, so each
 * case is a claim the compiler keeps honest. Type safety is what the compiler
 * rejects, not what the README says.
 */

import { z } from 'zod';
import { defineCache } from '../../src/cache/define-cache';
import { defineRedis } from '../../src/wiring/config/define-redis';
import { openRedis } from '../../src/wiring/open-redis';
import type { RedisOf } from '../../src/wiring/types';
import * as caches from '../wiring/caches';
import * as channels from '../wiring/channels';
import * as idempotency from '../wiring/idempotency';
import * as limits from '../wiring/limits';

const uri = 'redis://127.0.0.1:6379';

async function soleInstance() {
	const redis = await openRedis(defineRedis({ uri, caches, channels }));

	// A cache that is not wired.
	// @ts-expect-error
	redis.cache.nope;

	// A channel that is not wired.
	// @ts-expect-error
	redis.channels.nope;

	// `users` is keyed by a string id, not an object.
	// @ts-expect-error
	await redis.cache.users.get({ id: 'ada' });

	// `seats` is keyed by an object, not a string.
	// @ts-expect-error
	await redis.cache.seats.get('ada');

	// A field the schema does not have.
	await redis.cache.users.set('ada', {
		id: 'ada',
		email: 'a@b.c',
		// @ts-expect-error
		admin: true,
	});

	// A missing required field.
	// @ts-expect-error
	await redis.cache.users.set('ada', { id: 'ada' });

	// `created` carries a user, not an id alone.
	// @ts-expect-error
	await redis.channels.created.publish({ id: 'ada' });

	// The handler is given the payload the schema describes.
	await redis.channels.created.subscribe((payload) => {
		// @ts-expect-error
		payload.admin;
	});

	// An instance this configuration does not name.
	// @ts-expect-error
	redis.instances.pubsub;

	// The same, on a lock.
	// @ts-expect-error
	await redis.lock('k', () => 1, { on: 'pubsub' });

	// These are the shapes that must keep compiling.
	await redis.cache.users.set('ada', { id: 'ada', email: 'a@b.c', seats: 1 });
	// `seats` has a `.default()`: a write may leave it out, a read has it.
	await redis.cache.users.set('ada', { id: 'ada', email: 'a@b.c' });
	const read = await redis.cache.users.remember('ada', () => ({
		id: 'ada',
		email: 'a@b.c',
	}));
	const seatCount: number = read.seats;
	void seatCount;
	await redis.cache.seats.get({ org: 'acme', user: 'ada' });
	await redis.channels.created.publish({ id: 'ada', email: 'a@b.c', seats: 1 });
	await redis.lock('k', () => 1);
	redis.instances.default.client;
	await redis.close();
}

async function severalInstances() {
	const redis = await openRedis(
		defineRedis({
			instances: {
				cache: { uri, caches },
				pubsub: { uri, channels },
			},
		}),
	);

	// `redis.cache` is `never` with more than one instance: naming the Redis is
	// the only way, and the compiler says so before anything runs.
	// @ts-expect-error
	redis.cache.users;

	// @ts-expect-error
	redis.channels.created;

	// And `never` itself, not merely a scope with no key on it — the two read
	// the same in an error message and are not the same type.
	const noCache: never = redis.cache;
	const noChannels: never = redis.channels;
	void noCache;
	void noChannels;

	// `pubsub` wires no cache.
	// @ts-expect-error
	redis.instances.pubsub.cache.users;

	// `cache` wires no channel.
	// @ts-expect-error
	redis.instances.cache.channels.created;

	// A lock must name which Redis it lives on, and only one this Redis has.
	// @ts-expect-error
	await redis.lock('k', () => 1, { on: 'nope' });

	// These must keep compiling.
	await redis.instances.cache.cache.users.get('ada');
	await redis.instances.pubsub.channels.created.publish({
		id: 'ada',
		email: 'a@b.c',
		seats: 1,
	});
	await redis.lock('k', () => 1, { on: 'cache' });
	const answered = await redis.ping();
	answered.cache.ok;
	answered.pubsub.ok;
	await redis.close();
}

async function wiredGuards() {
	const redis = await openRedis(defineRedis({ uri, limits, idempotency }));

	// A limit and an idempotency that are not wired.
	// @ts-expect-error
	redis.limits.nope;
	// @ts-expect-error
	redis.idempotency.nope;

	// A cache is not wired under `limits`, nor a limit under `idempotency`.
	// @ts-expect-error
	redis.limits.users;
	// @ts-expect-error
	redis.idempotency.login;

	// `login` is keyed by an object, `charges` by a string.
	// @ts-expect-error
	await redis.limits.login.consume('10.0.0.1');
	// @ts-expect-error
	await redis.idempotency.charges.run({ key: 'k' }, () => ({ chargeId: 'x' }));

	// `work` returns what the schema accepts.
	// @ts-expect-error
	await redis.idempotency.charges.run('k', () => ({ id: 'x' }));

	// A cache under `limits`, a limit under `idempotency` and the other two
	// crossings are refused by the configuration, on the export's own key.
	// @ts-expect-error
	defineRedis({ uri, limits: { users: caches.users } });
	// @ts-expect-error
	defineRedis({ uri, limits: caches });
	// @ts-expect-error
	defineRedis({ uri, idempotency: { login: limits.login } });
	// @ts-expect-error
	defineRedis({ uri, limits: { orders: idempotency.orders } });
	// @ts-expect-error
	defineRedis({ uri, idempotency: { users: caches.users } });

	// An idempotency is not a cache either.
	const notCaches = await openRedis(
		defineRedis({ uri, caches: { orders: idempotency.orders }, limits }),
	);
	// @ts-expect-error
	notCaches.cache.orders;

	// With several instances `redis.limits` is `never`, as `redis.cache` is.
	const several = await openRedis(
		defineRedis({
			instances: { a: { uri, limits }, b: { uri, idempotency } },
		}),
	);
	const noLimits: never = several.limits;
	void noLimits;
	// @ts-expect-error
	several.instances.a.idempotency.orders;

	// These must keep compiling.
	const result = await redis.limits.login.consume({ ip: '10.0.0.1' });
	const left: number = result.remaining;
	void left;
	await redis.limits.exports.enforce({ org: 'acme', user: 'ada' }, 2);
	const done = await redis.idempotency.orders.run(
		{ user: 'u', key: 'k' },
		() => ({ orderId: 'o', total: 1 }),
	);
	const status: string = done.value.status;
	void status;
	await redis.idempotency.charges.run('k', () => ({ chargeId: 'x' }));
	defineRedis({ uri, limits, idempotency, caches, channels });
	await several.instances.a.limits.login.peek({ ip: 'x' });
	await redis.close();
}

/**
 * `RedisOf` types a Redis from the configuration alone — a service that is handed
 * one, rather than reading `Awaited<ReturnType<typeof openRedis>>` back.
 *
 * It is a claim about what `RedisConfig` carries: the instances it freezes hold
 * `caches` as an optional field, so reading the caches back off that shape
 * alone gives an empty scope. These lines fail the build if that regresses.
 */
function redisFromConfig() {
	const config = defineRedis({ uri, caches, channels });
	type Wiring = RedisOf<typeof config>;

	return (redis: Wiring) => {
		// A cache this configuration does not wire.
		// @ts-expect-error
		redis.cache.nope;

		// These must keep compiling.
		void redis.cache.users.get('ada');
		void redis.channels.created.name;
		void redis.instances.default.client;
	};
}

function configRefusals() {
	// A cache under a key that is not a definition is simply not wired, which
	// is not an error — but asking for it is.
	const redis = defineRedis({ uri, caches });
	redis.instances.default.uri;

	const orphan = defineCache({
		name: 'orphan',
		key: (id: string) => id,
		ttl: 5,
		schema: z.object({ id: z.string() }),
	});

	// An option the config does not have.
	// @ts-expect-error
	defineRedis({ uri, caches, nope: true });

	// `prefix` is a string.
	// @ts-expect-error
	defineRedis({ uri, caches, prefix: 5 });

	// These must keep compiling.
	defineRedis({ uri, caches: { orphan } });
	defineRedis({ uri, prefix: 'myapp', caches, channels });
	defineRedis({ instances: { a: { uri, caches } } });
}

/**
 * A field whose input is `unknown` — `z.coerce.number()` — takes any value,
 * though its key is still required, and a whole `z.preprocess` schema takes
 * anything: there, `set` is checked at run time only, by the schema.
 */
async function unknownInputs() {
	const counts = defineCache({
		name: 'count',
		key: (id: string) => id,
		ttl: 5,
		schema: z.object({ n: z.coerce.number() }),
	});
	const parsed = defineCache({
		name: 'parsed',
		key: (id: string) => id,
		ttl: 5,
		schema: z.preprocess((value) => Number(value), z.number()),
	});
	const redis = await openRedis(
		defineRedis({ uri, caches: { counts, parsed } }),
	);

	// `n` is still required: `unknown` is its value, not its key.
	// @ts-expect-error
	await redis.cache.counts.set('c1', {});

	// A loader still gives the object, with its `n`.
	// @ts-expect-error
	await redis.cache.counts.remember('c1', () => ({}));

	// What is read is the number the schema produces, not what was written.
	// @ts-expect-error
	const parsedAsString: string | undefined = await redis.cache.parsed.get('p1');
	void parsedAsString;

	// These must keep compiling.
	await redis.cache.counts.set('c1', { n: '3' });
	await redis.cache.counts.set('c1', { n: { not: 'a number' } });
	await redis.cache.counts.remember('c1', () => ({ n: '3' }));
	await redis.cache.parsed.set('p1', '3');
	await redis.cache.parsed.set('p1', { any: 'thing' });
	await redis.cache.parsed.set('p1', null);
	await redis.cache.parsed.remember('p1', () => Symbol('anything'));
	const parsedRead: number | undefined = await redis.cache.parsed.get('p1');
	void parsedRead;
	await redis.close();
}

export {
	configRefusals,
	redisFromConfig,
	severalInstances,
	soleInstance,
	unknownInputs,
	wiredGuards,
};

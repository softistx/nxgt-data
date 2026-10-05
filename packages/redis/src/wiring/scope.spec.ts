import { beforeEach, describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import * as caches from '../../test/wiring/caches';
import * as channels from '../../test/wiring/channels';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;

async function redisOn(prefix?: string) {
	return track(
		await openRedis(
			defineRedis({ uri: servers.redis.uri, prefix, caches, channels }),
		),
	);
}

describe('the scopes', () => {
	let redis: Awaited<ReturnType<typeof redisOn>>;
	beforeEach(async () => {
		redis = await redisOn();
	});

	test('a cache is reached under the key it is exported as', async () => {
		await redis.cache.users.set('ada', {
			id: 'ada',
			email: 'ada@example.com',
			seats: 2,
		});
		expect(await redis.cache.users.get('ada')).toEqual({
			id: 'ada',
			email: 'ada@example.com',
			seats: 2,
		});
	});

	test('a channel is reached under its own key, beside the caches', () => {
		// Two scopes, not one: a cache and a channel could be named the same
		// thing without either shadowing the other.
		expect(redis.channels.created.name).toBe('user.created');
		expect(redis.channels.deleted.name).toBe('user.deleted');
	});

	test('only the definitions are wired; the rest of the module is skipped', () => {
		// `test/caches.ts` also exports a schema and a string, and
		// `test/channels.ts` a type. An application passes the module as it is.
		expect(Object.keys(redis.cache).sort()).toEqual(['seats', 'users']);
		expect(Object.keys(redis.channels).sort()).toEqual(['created', 'deleted']);
	});

	test('a key that is wired nowhere is plainly undefined', () => {
		// Nothing falls through to a driver here, unlike the wiring in `@nxgt/mongo`, whose
		// scope sits over `Db`: a name that is not wired has nothing behind it.
		expect((redis.cache as Record<string, unknown>)['nope']).toBeUndefined();
		expect((redis.channels as Record<string, unknown>)['nope']).toBeUndefined();
	});

	test('the same key gives the same object back, built once', () => {
		// Built on the first read and kept: an application wires everything it
		// has and a request touches two of them.
		expect(redis.cache.users).toBe(redis.cache.users);
		expect(redis.channels.created).toBe(redis.channels.created);
	});

	test('the scope is frozen, so nothing can be wired onto it later', () => {
		expect(Object.isFrozen(redis.cache)).toBe(true);
		expect(Object.isFrozen(redis.channels)).toBe(true);
	});

	test('the raw client is there for a command this package does not wrap', async () => {
		await redis.instances.default.client.set('straight', 'through');
		expect(await redis.instances.default.client.get('straight')).toBe(
			'through',
		);
	});
});

describe('the prefix', () => {
	test('goes in front of a cache key, so two deployments do not collide', async () => {
		const redis = await redisOn('myapp:prod');
		await redis.cache.users.set('ada', { id: 'ada', email: 'a@b.c', seats: 1 });

		// What the definition alone would have written:
		expect(await servers.redis.client.get('user:ada')).toBeNull();
		// What the prefix makes it write:
		expect(
			await servers.redis.client.get('myapp:prod:user:ada'),
		).not.toBeNull();
		expect(redis.cache.users.keyFor('ada')).toBe('myapp:prod:user:ada');
	});

	test('goes in front of a channel name too', async () => {
		const redis = await redisOn('myapp:prod');
		expect(redis.channels.created.name).toBe('myapp:prod:user.created');
	});

	test('two Redis objects can wire one definition under two prefixes', async () => {
		// The Redis copies the definition rather than renaming it, so the module
		// an application exports is never mutated by being wired.
		const prod = await redisOn('prod');
		const staging = await redisOn('staging');
		await prod.cache.users.set('ada', { id: 'ada', email: 'p@b.c', seats: 1 });
		await staging.cache.users.set('ada', {
			id: 'ada',
			email: 's@b.c',
			seats: 9,
		});

		expect((await prod.cache.users.get('ada'))?.email).toBe('p@b.c');
		expect((await staging.cache.users.get('ada'))?.email).toBe('s@b.c');
		expect(caches.users.name).toBe('user');
	});

	test('no prefix writes exactly what the definition says', async () => {
		const redis = await redisOn();
		expect(redis.instances.default.prefix).toBeUndefined();
		expect(redis.cache.users.keyFor('ada')).toBe('user:ada');
		expect(redis.channels.created.name).toBe(channels.created.name);
	});
});

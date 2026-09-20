import { beforeEach, describe, expect, test } from 'bun:test';
import * as caches from '../../test/caches';
import * as channels from '../../test/channels';
import { useRedis } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { connectKit } from './connect-kit';

const { servers, track } = useRedis();

async function kitOn(prefix?: string) {
	return track(
		await connectKit(
			defineConfig({ uri: servers.redis.uri, prefix, caches, channels }),
		),
	);
}

describe('the scopes', () => {
	let kit: Awaited<ReturnType<typeof kitOn>>;
	beforeEach(async () => {
		kit = await kitOn();
	});

	test('a cache is reached under the key it is exported as', async () => {
		await kit.cache.users.set('ada', {
			id: 'ada',
			email: 'ada@example.com',
			seats: 2,
		});
		expect(await kit.cache.users.get('ada')).toEqual({
			id: 'ada',
			email: 'ada@example.com',
			seats: 2,
		});
	});

	test('a channel is reached under its own key, beside the caches', () => {
		// Two scopes, not one: a cache and a channel could be named the same
		// thing without either shadowing the other.
		expect(kit.channels.created.name).toBe('user.created');
		expect(kit.channels.deleted.name).toBe('user.deleted');
	});

	test('only the definitions are wired; the rest of the module is skipped', () => {
		// `test/caches.ts` also exports a schema and a string, and
		// `test/channels.ts` a type. An application passes the module as it is.
		expect(Object.keys(kit.cache).sort()).toEqual(['seats', 'users']);
		expect(Object.keys(kit.channels).sort()).toEqual(['created', 'deleted']);
	});

	test('a key that is wired nowhere is plainly undefined', () => {
		// Nothing falls through to a driver here, unlike `@nxgt/mongo-kit`'s
		// scope over `Db`: a name that is not wired has nothing behind it.
		expect((kit.cache as Record<string, unknown>).nope).toBeUndefined();
		expect((kit.channels as Record<string, unknown>).nope).toBeUndefined();
	});

	test('the same key gives the same object back, built once', () => {
		// Built on the first read and kept: an application wires everything it
		// has and a request touches two of them.
		expect(kit.cache.users).toBe(kit.cache.users);
		expect(kit.channels.created).toBe(kit.channels.created);
	});

	test('the scope is frozen, so nothing can be wired onto it later', () => {
		expect(Object.isFrozen(kit.cache)).toBe(true);
		expect(Object.isFrozen(kit.channels)).toBe(true);
	});

	test('the raw client is there for a command this package does not wrap', async () => {
		await kit.instances.default.client.set('straight', 'through');
		expect(await kit.instances.default.client.get('straight')).toBe('through');
	});
});

describe('the prefix', () => {
	test('goes in front of a cache key, so two deployments do not collide', async () => {
		const kit = await kitOn('myapp:prod');
		await kit.cache.users.set('ada', { id: 'ada', email: 'a@b.c', seats: 1 });

		// What the definition alone would have written:
		expect(await servers.redis.client.get('user:ada')).toBeNull();
		// What the prefix makes it write:
		expect(
			await servers.redis.client.get('myapp:prod:user:ada'),
		).not.toBeNull();
		expect(kit.cache.users.keyFor('ada')).toBe('myapp:prod:user:ada');
	});

	test('goes in front of a channel name too', async () => {
		const kit = await kitOn('myapp:prod');
		expect(kit.channels.created.name).toBe('myapp:prod:user.created');
	});

	test('two kits can wire one definition under two prefixes', async () => {
		// The kit copies the definition rather than renaming it, so the module
		// an application exports is never mutated by being wired.
		const prod = await kitOn('prod');
		const staging = await kitOn('staging');
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
		const kit = await kitOn();
		expect(kit.instances.default.prefix).toBeUndefined();
		expect(kit.cache.users.keyFor('ada')).toBe('user:ada');
		expect(kit.channels.created.name).toBe(channels.created.name);
	});
});

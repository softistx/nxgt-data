import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { seatCache, useRedis, userCache } from '../../test/fixtures';
import { RedisError } from '../errors/redis-error';
import { bindCache } from './bind-cache';
import { defineCache } from './define-cache';

const servers = useRedis();
const users = () => bindCache(servers.redis.client, userCache);

const ada = { id: 'u1', email: 'ada@example.com', seats: 1 };

describe('defineCache', () => {
	test('refuses a cache with no name, which would key on nothing', () => {
		expect(() =>
			defineCache({
				name: '',
				key: (id: string) => id,
				ttl: 60,
				schema: z.string(),
			}),
		).toThrow('needs a name');
	});

	test('refuses a ttl that is not a positive number of seconds', () => {
		for (const ttl of [0, -1, Number.NaN]) {
			expect(() =>
				defineCache({
					name: 'x',
					key: (id: string) => id,
					ttl,
					schema: z.string(),
				}),
			).toThrow('number of seconds');
		}
	});

	test('is frozen, so a definition cannot drift after it is shared', () => {
		expect(Object.isFrozen(userCache)).toBe(true);
	});
});

describe('a bound cache', () => {
	test('keys under the definition’s name', () => {
		expect(users().keyFor('u1')).toBe('user:u1');
		expect(
			bindCache(servers.redis.client, seatCache).keyFor({
				org: 'acme',
				user: 'u1',
			}),
		).toBe('seat:acme/u1');
	});

	test('stores and gives back, and misses give undefined', async () => {
		const cache = users();
		expect(await cache.get('u1')).toBeUndefined();
		await cache.set('u1', ada);
		expect(await cache.get('u1')).toEqual(ada);
	});

	test('sets the definition’s ttl, and the one a call overrides it with', async () => {
		const cache = users();
		await cache.set('u1', ada);
		expect(await servers.redis.client.ttl('user:u1')).toBeGreaterThan(50);
		await cache.set('u2', { ...ada, id: 'u2' }, { ttl: 5 });
		expect(await servers.redis.client.ttl('user:u2')).toBeLessThanOrEqual(5);
	});

	test('forgets, and says whether anything was there', async () => {
		const cache = users();
		expect(await cache.delete('u1')).toBe(false);
		await cache.set('u1', ada);
		expect(await cache.delete('u1')).toBe(true);
		expect(await cache.get('u1')).toBeUndefined();
	});

	test('remember loads once, then answers from the cache', async () => {
		const cache = users();
		let loads = 0;
		const load = () => {
			loads += 1;
			return ada;
		};
		expect(await cache.remember('u1', load)).toEqual(ada);
		expect(await cache.remember('u1', load)).toEqual(ada);
		expect(loads).toBe(1);
	});

	test('remember gives back what a later get gives back', async () => {
		// A loader hands back the row it read, which carries more than the
		// schema keeps — no cast needed, an extra property is assignable.
		// Were `remember` to return that object rather than what it stored,
		// the caller that missed would see `role` and nobody after it would,
		// for the whole ttl.
		const cache = users();
		const row = { id: 'u1', email: 'ada@example.com', seats: 2, role: 'admin' };
		const missed = await cache.remember('u1', () => row);
		const hit = await cache.get('u1');
		expect(missed).toEqual(hit as typeof ada);
		expect(missed).toEqual({ id: 'u1', email: 'ada@example.com', seats: 2 });
	});

	test('refuses a value the schema does not accept, before storing it', async () => {
		const cache = users();
		const wrong = { id: 'u1', email: 42 } as unknown as typeof ada;
		await expect(cache.set('u1', wrong)).rejects.toThrow(RedisError);
		// Nothing was written: a refused value is not a half-write.
		expect(await servers.redis.client.get('user:u1')).toBeNull();
	});

	test('a stored shape from an older deploy is a miss, and is forgotten', async () => {
		// What a previous version of this schema might have stored.
		await servers.redis.client.set('user:u1', JSON.stringify({ id: 'u1' }));
		const cache = users();
		expect(await cache.get('u1')).toBeUndefined();
		// Forgotten, so the next `remember` reloads rather than missing again.
		expect(await servers.redis.client.get('user:u1')).toBeNull();
	});

	test('something that is not this package’s JSON is a miss too', async () => {
		await servers.redis.client.set('user:u1', 'not json at all');
		expect(await users().get('u1')).toBeUndefined();
		expect(await servers.redis.client.get('user:u1')).toBeNull();
	});

	test('the schema’s defaults are applied on the way in', async () => {
		const cache = users();
		await cache.set('u1', { id: 'u1', email: 'a@b.c' } as typeof ada);
		expect(await cache.get('u1')).toEqual({
			id: 'u1',
			email: 'a@b.c',
			seats: 1,
		});
	});
});

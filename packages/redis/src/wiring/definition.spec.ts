import { describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { useRedis } from '../../test/fixtures';
import * as caches from '../../test/wiring/caches';
import * as channels from '../../test/wiring/channels';
import * as idempotency from '../../test/wiring/idempotency';
import * as limits from '../../test/wiring/limits';
import { bindCache } from '../cache/bind-cache';
import { bindIdempotency } from '../idempotency/bind-idempotency';
import { bindRateLimit } from '../rate-limit/bind-rate-limit';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;

/** Never connects: binding sends nothing. */
const client = new RedisClient('redis://127.0.0.1:1');

describe('a bound guard, by hand', () => {
	test('exposes the definition it was given, not a copy', () => {
		expect(bindRateLimit(client, limits.login).definition).toBe(limits.login);
		expect(bindIdempotency(client, idempotency.orders).definition).toBe(
			idempotency.orders,
		);
		expect(bindCache(client, caches.users).definition).toBe(caches.users);
	});

	test('reads the policy', () => {
		const login = bindRateLimit(client, limits.login).definition;
		expect([login.limit, login.per]).toEqual([5, 60_000]);
		const orders = bindIdempotency(client, idempotency.orders).definition;
		expect([orders.ttl, orders.lease]).toEqual([3600, 5_000]);
		expect(bindCache(client, caches.users).definition.ttl).toBe(60);
	});
});

describe('a bound guard, wired with a prefix', () => {
	const open = async () =>
		track(
			await openRedis(
				defineRedis({
					uri: servers.redis.uri,
					prefix: 'app',
					caches,
					channels,
					limits,
					idempotency,
				}),
			),
		);

	test('carries the prefixed name and the original policy', async () => {
		const redis = await open();
		const login = redis.limits.login.definition;
		expect(login.name).toBe('app:login');
		expect([login.limit, login.per]).toEqual([5, 60_000]);
		const orders = redis.idempotency.orders.definition;
		expect(orders.name).toBe('app:orders.create');
		expect([orders.ttl, orders.lease]).toEqual([3600, 5_000]);
		const users = redis.cache.users.definition;
		expect(users.name).toBe('app:user');
		expect(users.ttl).toBe(60);
		expect(redis.channels.created.definition.name).toBe('app:user.created');
	});

	test('is the name that is written, and is frozen', async () => {
		const redis = await open();
		expect(redis.limits.login.keyFor({ ip: 'x' })).toStartWith(
			`${redis.limits.login.definition.name}:`,
		);
		for (const bound of [
			redis.limits.login,
			redis.idempotency.orders,
			redis.cache.users,
			redis.channels.created,
		]) {
			expect(Object.isFrozen(bound.definition)).toBe(true);
			expect(() => {
				(bound.definition as { name: string }).name = 'other';
			}).toThrow(TypeError);
		}
		expect(limits.login.name).toBe('login');
	});
});

import { describe, expect, test } from 'bun:test';
import { counted, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import * as caches from '../../test/wiring/caches';
import * as idempotency from '../../test/wiring/idempotency';
import * as limits from '../../test/wiring/limits';
import { GuardError } from '../errors/guard-error';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;
const ada = { ip: '10.0.0.1' };

const one = (prefix?: string) =>
	defineRedis({ uri: servers.redis.uri, prefix, limits, idempotency });

describe('wired rate limits', () => {
	test('count and refuse as the hand-bound one does', async () => {
		const redis = track(await openRedis(one()));
		const results = [];
		for (let i = 0; i < 6; i += 1) {
			results.push(await redis.limits.login.consume(ada));
		}
		expect(results.map((r) => r.allowed)).toEqual([
			true,
			true,
			true,
			true,
			true,
			false,
		]);
		expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
		const denied = await rejection(redis.limits.login.enforce(ada));
		expect(denied).toBeInstanceOf(GuardError);
		expect((denied as GuardError).code).toBe('RATE_LIMITED');
	});

	test('a refusal names the prefixed definition, as a cache error does', async () => {
		const redis = track(await openRedis(one('myapp')));
		for (let i = 0; i < 5; i += 1) await redis.limits.login.consume(ada);
		const denied = (await rejection(
			redis.limits.login.enforce(ada),
		)) as GuardError;
		expect(denied.definition).toBe('myapp:login');
		expect(denied.message).toContain('enforce on "myapp:login"');
	});

	test('without a prefix the key is the hand-bound one', async () => {
		const redis = track(await openRedis(one()));
		await redis.limits.login.consume(ada);
		expect(redis.limits.login.keyFor(ada)).toBe('login:10.0.0.1');
		expect(await servers.redis.client.exists('login:10.0.0.1')).toBe(true);
	});

	test('the prefix is in the stored key', async () => {
		const redis = track(await openRedis(one('myapp:prod')));
		await redis.limits.login.consume(ada);
		expect(redis.limits.login.keyFor(ada)).toBe('myapp:prod:login:10.0.0.1');
		expect(await servers.redis.client.exists('myapp:prod:login:10.0.0.1')).toBe(
			true,
		);
		expect(await servers.redis.client.exists('login:10.0.0.1')).toBe(false);
	});

	test('two instances with different prefixes do not share counts', async () => {
		const redis = track(
			await openRedis(
				defineRedis({
					instances: {
						a: { uri: servers.redis.uri, prefix: 'a', limits },
						b: { uri: servers.redis.uri, prefix: 'b', limits },
					},
				}),
			),
		);
		for (let i = 0; i < 5; i += 1) {
			await redis.instances.a.limits.login.consume(ada);
		}
		expect((await redis.instances.a.limits.login.consume(ada)).allowed).toBe(
			false,
		);
		const other = await redis.instances.b.limits.login.consume(ada);
		expect(other.allowed).toBe(true);
		expect(other.remaining).toBe(4);
	});

	test('a key built from several params is under the prefix too', async () => {
		const redis = track(await openRedis(one('p')));
		const key = { org: 'acme', user: 'ada' };
		await redis.limits.exports.consume(key);
		expect(await servers.redis.client.exists('p:export:acme/ada')).toBe(true);
		expect(await redis.limits.exports.reset(key)).toBe(true);
	});

	test('the scope lists what is wired, and skips what is not a definition', async () => {
		const redis = track(await openRedis(one()));
		expect(Object.keys(redis.limits).sort()).toEqual(['exports', 'login']);
		expect(redis.limits).toBe(redis.instances.default.limits);
		expect(redis.limits.login).toBe(redis.limits.login);
	});

	test('redis.limits refuses to guess with several instances', async () => {
		const redis = track(
			await openRedis(
				defineRedis({
					instances: {
						a: { uri: servers.redis.uri, limits },
						b: { uri: servers.redis.uri, caches },
					},
				}),
			),
		);
		expect(() => redis.limits).toThrow(/limits: this Redis holds 2/);
		expect(() => redis.idempotency).toThrow(/idempotency: this Redis holds 2/);
		expect(Object.keys(redis.instances.b.limits)).toEqual([]);
	});
});

describe('wired idempotency', () => {
	const who = { user: 'u1', key: 'k1' };

	test('runs once per key and replays the result', async () => {
		const redis = track(await openRedis(one()));
		const work = counted();
		const first = await redis.idempotency.orders.run(who, work);
		const again = await redis.idempotency.orders.run(who, work);
		expect(first.replayed).toBe(false);
		expect(again.replayed).toBe(true);
		expect(again.value).toEqual({
			orderId: 'o1',
			total: 1250,
			status: 'placed',
		});
		expect(work.calls).toBe(1);
	});

	test('the prefix is in the stored key', async () => {
		const redis = track(await openRedis(one('myapp:prod')));
		await redis.idempotency.orders.run(who, counted());
		const key = 'myapp:prod:orders.create:u1/k1';
		expect(redis.idempotency.orders.keyFor(who)).toBe(key);
		expect(await servers.redis.client.exists(key)).toBe(true);
		expect(await servers.redis.client.exists('orders.create:u1/k1')).toBe(
			false,
		);
	});

	test('two prefixes do not share a result', async () => {
		const a = track(await openRedis(one('a')));
		const b = track(await openRedis(one('b')));
		const work = counted();
		await a.idempotency.orders.run(who, work);
		const other = await b.idempotency.orders.run(who, work);
		expect(other.replayed).toBe(false);
		expect(work.calls).toBe(2);
	});

	test('forget works under the prefix', async () => {
		const redis = track(await openRedis(one('p')));
		await redis.idempotency.charges.run('c1', () => ({ chargeId: 'x' }));
		expect(await redis.idempotency.charges.forget('c1')).toBe(true);
		expect(await redis.idempotency.charges.forget('c1')).toBe(false);
	});
});

describe('config refusals', () => {
	const uri = 'redis://127.0.0.1:6379';

	test('a cache under limits is refused, naming where it belongs', () => {
		expect(() =>
			// @ts-expect-error a cache is not a rate limit
			defineRedis({ uri, limits: { users: caches.users } }),
		).toThrow(
			'defineRedis: instance "default" has "users" under limits, which is a ' +
				'cache, not a rate limit. Wire it under caches, or keep it out of this module.',
		);
	});

	test('a rate limit under idempotency is refused', () => {
		expect(() =>
			// @ts-expect-error a rate limit is not an idempotency
			defineRedis({ uri, idempotency: { login: limits.login } }),
		).toThrow(
			'defineRedis: instance "default" has "login" under idempotency, which is ' +
				'a rate limit, not an idempotency. Wire it under limits, or keep it out of this module.',
		);
	});

	test('a cache under idempotency, and an idempotency under limits, are refused', () => {
		expect(() =>
			// @ts-expect-error
			defineRedis({ uri, idempotency: { users: caches.users } }),
		).toThrow(
			/has "users" under idempotency, which is a cache, not an idempotency/,
		);
		expect(() =>
			// @ts-expect-error
			defineRedis({ uri, limits: { orders: idempotency.orders } }),
		).toThrow(
			/has "orders" under limits, which is an idempotency, not a rate limit/,
		);
	});

	test('an idempotency is not taken for a cache under caches', () => {
		expect(() =>
			defineRedis({ uri, caches: { orders: idempotency.orders } }),
		).toThrow(/wires no cache, no channel, no rate limit and no idempotency/);
	});

	test('an idempotency written by hand without its lease is a cache, and refused', () => {
		// `defineIdempotency` always fills the lease; without one the shape is a
		// cache's, which `bindIdempotency` would turn into a WRONGTYPE.
		const { lease: _lease, ...noLease } = idempotency.orders;
		expect(() =>
			// @ts-expect-error a definition with no lease is not an idempotency
			defineRedis({ uri, idempotency: { orders: noLease } }),
		).toThrow(
			/has "orders" under idempotency, which is a cache, not an idempotency/,
		);
	});

	test('a half-written rate limit, with no per, is not wired', () => {
		const { per: _per, ...noPer } = limits.login;
		expect(() => defineRedis({ uri, limits: { login: noPer } })).toThrow(
			/wires no cache, no channel, no rate limit and no idempotency/,
		);
	});

	test('openRedis runs the same refusal, on a configuration built elsewhere', async () => {
		const byHand = {
			instances: { main: { uri: servers.redis.uri, limits: caches } },
		} as never;
		const error = await rejection(openRedis(byHand));
		expect((error as Error).message).toContain(
			'openRedis: instance "main" has "seats" under limits, which is a cache',
		);
	});

	test('one rate limit wired twice is refused, as a cache is', () => {
		expect(() =>
			defineRedis({ uri, limits: { a: limits.login, b: limits.login } }),
		).toThrow(
			'defineRedis: instance "default" wires the rate limit named "login" twice, ' +
				'under "a" and "b". They would share every key in Redis. ' +
				'Export one of them, or give it a name of its own.',
		);
	});

	test('one idempotency wired twice is refused', () => {
		expect(() =>
			defineRedis({
				uri,
				idempotency: { a: idempotency.orders, b: idempotency.orders },
			}),
		).toThrow(/wires the idempotency named "orders\.create" twice/);
	});

	test('limits alone are enough to wire an instance', () => {
		expect(() => defineRedis({ uri, limits })).not.toThrow();
		expect(() => defineRedis({ uri, idempotency })).not.toThrow();
	});
});

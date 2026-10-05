import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import * as caches from '../../../test/wiring/caches';
import * as idempotency from '../../../test/wiring/idempotency';
import * as limits from '../../../test/wiring/limits';
import { openRedis } from '../open-redis';
import { defineRedis } from './define-redis';

const servers = useRedis();

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

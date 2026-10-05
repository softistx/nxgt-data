import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import * as caches from '../../../test/wiring/caches';
import * as idempotency from '../../../test/wiring/idempotency';
import * as limits from '../../../test/wiring/limits';
import { defineChannel } from '../../channel/define-channel';
import { openRedis } from '../open-redis';
import { defineRedis } from './define-redis';

const servers = useRedis();

describe('config refusals', () => {
	const uri = 'redis://127.0.0.1:6379';

	test('a slot keeps only its own kind: a cache under limits is skipped', () => {
		// The same rule as `caches` and `channels`: what is not a slot's own is
		// left where it is, so one module may be passed to several slots.
		expect(() => defineRedis({ uri, caches, limits: caches })).not.toThrow();
		expect(() => defineRedis({ uri, limits: caches })).toThrow(
			'defineRedis: instance "default" wires no cache, no channel, no rate ' +
				'limit and no idempotency. Pass the module that exports them, or drop the instance.',
		);
	});

	test('an idempotency is not taken for a cache under caches', () => {
		expect(() =>
			defineRedis({ uri, caches: { orders: idempotency.orders } }),
		).toThrow(/wires no cache, no channel, no rate limit and no idempotency/);
	});

	test('a definition with a lease that is not a number is not an idempotency', () => {
		// Nor a cache: it has a `lease`. It is skipped, and so is wired nowhere.
		for (const lease of [null, '5000']) {
			expect(() =>
				defineRedis({
					uri,
					idempotency: { orders: { ...idempotency.orders, lease } },
				}),
			).toThrow(/wires no cache, no channel, no rate limit and no idempotency/);
		}
	});

	test('an idempotency written by hand without its lease is a cache, and skipped here', () => {
		const { lease: _lease, ...noLease } = idempotency.orders;
		expect(() =>
			defineRedis({ uri, idempotency: { orders: noLease } }),
		).toThrow(/wires no cache, no channel, no rate limit and no idempotency/);
	});

	test('a half-written rate limit, with no per, is not wired', () => {
		const { per: _per, ...noPer } = limits.login;
		expect(() => defineRedis({ uri, limits: { login: noPer } })).toThrow(
			/wires no cache, no channel, no rate limit and no idempotency/,
		);
	});

	test('openRedis runs the same checks, on a configuration built elsewhere', async () => {
		const byHand = {
			instances: { main: { uri: servers.redis.uri, limits: caches } },
		} as never;
		const error = await rejection(openRedis(byHand));
		expect((error as Error).message).toContain(
			'openRedis: instance "main" wires no cache, no channel, no rate limit',
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

	describe('a name shared across the keys Redis holds', () => {
		const sameAsCache = { ...limits.login, name: caches.users.name };
		const sameAsLimit = { ...idempotency.orders, name: limits.login.name };
		const sameAsCacheToo = { ...idempotency.orders, name: caches.users.name };

		test('a cache and a rate limit are refused', () => {
			expect(() =>
				defineRedis({ uri, caches, limits: { login: sameAsCache } }),
			).toThrow(
				'defineRedis: instance "default" wires the cache "users" and the rate ' +
					'limit "login" under one name, "user". They would share every key in ' +
					'Redis. Give one of them a name of its own.',
			);
		});

		test('a rate limit and an idempotency are refused', () => {
			expect(() =>
				defineRedis({
					uri,
					limits,
					idempotency: { orders: sameAsLimit },
				}),
			).toThrow(
				/wires the rate limit "login" and the idempotency "orders" under one name, "login"/,
			);
		});

		test('a cache and an idempotency are refused', () => {
			expect(() =>
				defineRedis({ uri, caches, idempotency: { orders: sameAsCacheToo } }),
			).toThrow(
				/wires the cache "users" and the idempotency "orders" under one name, "user"/,
			);
		});

		test('openRedis refuses it too', async () => {
			const byHand = {
				instances: {
					main: {
						uri: servers.redis.uri,
						caches,
						limits: { login: sameAsCache },
					},
				},
			} as never;
			const error = await rejection(openRedis(byHand));
			expect((error as Error).message).toContain(
				'openRedis: instance "main" wires the cache',
			);
		});

		test('a channel named like a cache is fine: pub/sub is another namespace', () => {
			const same = defineChannel({
				name: caches.users.name,
				schema: z.object({ id: z.string() }),
			});
			expect(() =>
				defineRedis({ uri, caches, channels: { same } }),
			).not.toThrow();
		});

		test('the same name on two instances is fine: the check is per instance', () => {
			expect(() =>
				defineRedis({
					instances: {
						a: { uri, caches },
						b: { uri, limits: { login: sameAsCache } },
					},
				}),
			).not.toThrow();
		});
	});
});

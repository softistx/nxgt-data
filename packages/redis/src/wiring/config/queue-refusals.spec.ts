import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import * as caches from '../../../test/wiring/caches';
import * as idempotency from '../../../test/wiring/idempotency';
import * as limits from '../../../test/wiring/limits';
import * as mixed from '../../../test/wiring/mixed';
import * as queues from '../../../test/wiring/queues';
import { defineChannel } from '../../channel/define-channel';
import { openRedis } from '../open-redis';
import { defineRedis } from './define-redis';
import { isCache, isIdempotency, isQueue, isRateLimit } from './kinds';

const servers = useRedis();
const uri = 'redis://127.0.0.1:6379';

describe('queues in the configuration', () => {
	test('an instance wiring only queues is accepted', () => {
		const config = defineRedis({ uri, queues });
		expect(config.instances.default.queues).toBe(queues);
	});

	test('isQueue recognises a queue by shape, and no other kind', () => {
		expect(isQueue(queues.mails)).toBe(true);
		expect(isQueue(queues.digest)).toBe(true);
		for (const other of [
			caches.users,
			limits.login,
			idempotency.orders,
			defineChannel({ name: 'c', schema: z.string() }),
			null,
			'mails',
		]) {
			expect(isQueue(other)).toBe(false);
		}
		for (const guard of [isCache, isRateLimit, isIdempotency]) {
			expect(guard(queues.mails)).toBe(false);
		}
		const { backoff: _backoff, ...noBackoff } = queues.mails;
		expect(isQueue(noBackoff)).toBe(false);
		expect(isQueue({ ...queues.mails, key: () => 'k' })).toBe(false);
	});

	test('one queue under two keys is refused', () => {
		expect(() =>
			defineRedis({ uri, queues: { a: queues.mails, b: queues.mails } }),
		).toThrow(
			'defineRedis: instance "default" wires the queue named "mails" twice, ' +
				'under "a" and "b". They would share every key in Redis. Export one ' +
				'of them, or give it a name of its own.',
		);
	});

	test('a queue named like a cache is refused', () => {
		const same = { ...queues.mails, name: caches.users.name };
		expect(() => defineRedis({ uri, caches, queues: { same } })).toThrow(
			'defineRedis: instance "default" wires the cache "users" and the queue ' +
				'"same" under one name, "user". One name means one thing on an instance. ' +
				'Give one of them a name of its own.',
		);
	});

	test('a queue named like a rate limit is refused', () => {
		const same = { ...queues.mails, name: limits.login.name };
		expect(() => defineRedis({ uri, limits, queues: { same } })).toThrow(
			/wires the rate limit "login" and the queue "same" under one name, "login"/,
		);
	});

	test('a queue named like an idempotency is refused', () => {
		const same = { ...queues.mails, name: idempotency.orders.name };
		expect(() => defineRedis({ uri, idempotency, queues: { same } })).toThrow(
			/wires the idempotency "orders" and the queue "same" under one name, "orders\.create"/,
		);
	});

	test('a queue named like a channel is accepted', () => {
		const same = defineChannel({ name: 'mails', schema: z.string() });
		expect(() =>
			defineRedis({ uri, channels: { same }, queues }),
		).not.toThrow();
	});

	test('a prefix with a brace is refused when queues are wired', () => {
		for (const prefix of ['app{1', 'app}', '{app}']) {
			expect(() => defineRedis({ uri, prefix, queues })).toThrow(
				'defineRedis: instance "default" has a prefix with braces, and it ' +
					"wires queues; a queue's name is its keys' hash tag, so the prefix " +
					'in front of it cannot hold any.',
			);
		}
	});

	test('a prefix with a brace is still accepted without queues', () => {
		expect(() => defineRedis({ uri, prefix: '{app}', caches })).not.toThrow();
	});

	test('a module exporting a queue among caches gives the queue to queues only', () => {
		expect(() => defineRedis({ uri, queues: mixed })).not.toThrow();
		// Under `caches` the queue is skipped, so the instance wires nothing.
		expect(() => defineRedis({ uri, caches: { mails: mixed.mails } })).toThrow(
			/wires no cache, no channel, no rate limit, no idempotency and no queue/,
		);
		expect(() => defineRedis({ uri, caches: mixed })).not.toThrow();
	});

	test('nothing wired names queues too', () => {
		expect(() => defineRedis({ uri })).toThrow(
			'defineRedis: instance "default" wires no cache, no channel, no rate ' +
				'limit, no idempotency and no queue. Pass the module that exports ' +
				'them, or drop the instance.',
		);
	});

	describe('openRedis refuses them too', () => {
		const messageOf = async (instance: object) => {
			const byHand = { instances: { main: instance } } as never;
			return ((await rejection(openRedis(byHand))) as Error).message;
		};

		test('one queue under two keys', async () => {
			expect(
				await messageOf({
					uri: servers.redis.uri,
					queues: { a: queues.mails, b: queues.mails },
				}),
			).toContain('openRedis: instance "main" wires the queue named "mails"');
		});

		test('a queue named like a cache', async () => {
			const same = { ...queues.mails, name: caches.users.name };
			expect(
				await messageOf({ uri: servers.redis.uri, caches, queues: { same } }),
			).toContain(
				'openRedis: instance "main" wires the cache "users" and the queue',
			);
		});

		test('a prefix with a brace', async () => {
			expect(
				await messageOf({ uri: servers.redis.uri, prefix: 'a{b', queues }),
			).toContain(
				'openRedis: instance "main" has a prefix with braces, and it wires queues',
			);
		});
	});
});

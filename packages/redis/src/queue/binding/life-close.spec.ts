import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import type { QueueError } from '../../errors/queue-error';
import { defineQueue } from '../definition/define-queue';
import { RELEASE_MS } from '../timers';
import { bindQueueWith } from './bind-queue';
import { closeLife, openLife } from './life';

const servers = useRedis();

const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string() }),
});

/** The client, whose subscriber connections never answer a SUBSCRIBE. */
function hungSubscribe() {
	const never = new Promise<never>(() => undefined);
	const real = servers.redis.client;
	const subscribers: Array<{ close(): void }> = [];
	const proxy = new Proxy(real, {
		get(target, prop) {
			if (prop === 'duplicate') {
				return async () => {
					const subscriber = await target.duplicate();
					subscribers.push(subscriber);
					return new Proxy(subscriber, {
						get(inner, key) {
							if (key === 'subscribe') return () => never;
							const value = Reflect.get(inner, key, inner);
							return typeof value === 'function' ? value.bind(inner) : value;
						},
					});
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as RedisClient;
	return {
		proxy,
		release: () => {
			for (const subscriber of subscribers) subscriber.close();
		},
	};
}

describe('closing a Redis whose subscriber hangs', () => {
	test('closeLife resolves within the bound, and the pending finished rejects CLOSED', async () => {
		const hung = hungSubscribe();
		try {
			const life = openLife();
			const queue = bindQueueWith(hung.proxy, mails, {
				prefix: undefined,
				life,
			});
			const handle = await queue.add({ to: 'a' }, { id: 'a' });
			const pending = rejection(handle.finished());
			await Bun.sleep(50);
			const started = Date.now();
			await closeLife(life, undefined);
			expect(Date.now() - started).toBeLessThan(RELEASE_MS + 1000);
			expect(((await pending) as QueueError).code).toBe('CLOSED');
		} finally {
			hung.release();
		}
	});

	test('closeLife resolves when a tracked worker cannot unlisten its cancels', async () => {
		const hung = hungSubscribe();
		try {
			const life = openLife();
			const queue = bindQueueWith(hung.proxy, mails, {
				prefix: undefined,
				life,
			});
			queue.work(() => undefined);
			await Bun.sleep(50);
			const started = Date.now();
			await closeLife(life, 100);
			expect(Date.now() - started).toBeLessThan(RELEASE_MS + 1000);
		} finally {
			hung.release();
		}
	});
});

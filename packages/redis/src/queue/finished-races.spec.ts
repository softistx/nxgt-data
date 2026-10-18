import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import type { QueueError } from '../errors/queue-error';
import { bindQueue } from './bind-queue';
import { defineQueue } from './define-queue';
import { jobHandle } from './handle';
import { queueKeys } from './keys';
import { cancel } from './scripts/cancel';
import { claim } from './scripts/claim';
import { complete } from './scripts/settle';

const servers = useRedis();
const client = () => servers.redis.client;

const volatile = defineQueue({
	name: 'volatile',
	schema: z.object({ to: z.string() }),
	result: z.object({ count: z.number() }),
	keepCompleted: false,
});
const vkeys = queueKeys('volatile');

/**
 * The client, except that its first HMGET is preceded by `settle`, sent on
 * the same connection and not awaited: Redis runs the settle first, so its
 * event is already on its way to the subscriber when the HMGET finds the job
 * gone. That is the reviewer's race, made to happen every time.
 */
function settleBeforeFirstRead(
	settle: (real: RedisClient) => Promise<unknown>,
) {
	const real = client();
	let first = true;
	const sent: Promise<unknown>[] = [];
	const proxy = new Proxy(real, {
		get(target, prop) {
			if (prop === 'hmget') {
				return (...args: Parameters<typeof real.hmget>) => {
					if (first) {
						first = false;
						sent.push(settle(target).catch(() => undefined));
					}
					return target.hmget(...args);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { client: proxy, settled: () => Promise.all(sent) };
}

async function claimOne() {
	await bindQueue(client(), volatile).add({ to: 'a' }, { id: 'a' });
	const [job] = (await claim(client(), vkeys, 1, 30_000)).jobs;
	if (!job) throw new Error('nothing to claim');
	return job;
}

describe('finished when the outcome lands between the SUBSCRIBE and the first read', () => {
	test('a complete with keepCompleted false resolves the result, not NOT_FOUND', async () => {
		for (let round = 0; round < 20; round++) {
			await servers.redis.reset();
			const job = await claimOne();
			const proxy = settleBeforeFirstRead((real) =>
				complete(real, vkeys, volatile, 'a', job.token, '{"count":7}', false),
			);
			const handle = jobHandle(proxy.client, volatile, vkeys, 'a', false);
			expect(await handle.finished()).toEqual({ count: 7 });
			await proxy.settled();
		}
	});

	test('a cancel rejects CANCELED, not NOT_FOUND', async () => {
		for (let round = 0; round < 20; round++) {
			await servers.redis.reset();
			await claimOne();
			const proxy = settleBeforeFirstRead((real) => cancel(real, vkeys, 'a'));
			const handle = jobHandle(proxy.client, volatile, vkeys, 'a', false);
			const error = (await rejection(handle.finished())) as QueueError;
			expect(error.code).toBe('CANCELED');
			await proxy.settled();
		}
	});

	test('a job that is truly absent still rejects NOT_FOUND at once', async () => {
		const handle = jobHandle(client(), volatile, vkeys, 'ghost', false);
		const started = Date.now();
		const error = (await rejection(handle.finished())) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

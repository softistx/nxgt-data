import { describe, expect, test } from 'bun:test';
import {
	scriptCalls,
	settled,
	subscribed,
	useRedis,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import * as queues from '../../test/wiring/queues';
import type { QueueError } from '../errors/queue-error';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;
const client = () => servers.redis.client;

/** Handed-in client: the Redis opens no connection of its own. */
const handed = (prefix?: string) =>
	defineRedis({ client: client(), prefix, queues });

async function connections() {
	const list = (await client().send('CLIENT', ['LIST'])) as string;
	return list.split('\n').filter((line) => line.trim() !== '').length;
}

const to = (address: string) => ({ to: address });

describe('wired queues', () => {
	test('opening a Redis with queues and reading redis.queues costs nothing', async () => {
		const scripts = await scriptCalls(client());
		const clients = await connections();
		const redis = track(await openRedis(handed('app')));
		expect(redis.queues.mails.definition.name).toBe('mails');
		expect(redis.queues.digest.definition.name).toBe('digest');
		expect(await scriptCalls(client())).toBe(scripts);
		expect(await connections()).toBe(clients);
	});

	test('redis.queues.mails is memoised and is redis.instances.default.queues.mails', async () => {
		const redis = track(await openRedis(handed()));
		expect(redis.queues.mails).toBe(redis.queues.mails);
		expect(redis.queues.mails).toBe(redis.instances.default.queues.mails);
		expect(redis.queues).toBe(redis.instances.default.queues);
		expect(Object.keys(redis.queues)).toEqual(['digest', 'mails']);
	});

	test("wired without a prefix, the keys are bindQueue's", async () => {
		const redis = track(await openRedis(handed()));
		expect(redis.queues.mails.prefix).toBeUndefined();
		await redis.queues.mails.add(to('a@b.c'), { id: 'j1' });
		expect(await client().exists('queue:{mails}:job:j1')).toBe(true);
	});

	test('wired under app:prod, add → work → finished round-trips, and job.key is app:prod:mails:<id>:send', async () => {
		const redis = track(await openRedis(handed('app:prod')));
		let key = '';
		const worker = redis.queues.mails.work((job) => {
			key = job.key('send');
			return { messageId: 'm1' };
		});
		const handle = await redis.queues.mails.add(to('a@b.c'), { id: 'j1' });
		expect(await handle.finished()).toEqual({ messageId: 'm1' });
		expect(key).toBe('app:prod:mails:j1:send');
		expect(redis.queues.mails.prefix).toBe('app:prod');
		expect(await client().exists('queue:{app:prod:mails}:job:j1')).toBe(true);
		await worker.close();
	});

	test('the events channel is prefixed: a direct PUBLISH on it ends a pending finished', async () => {
		const redis = track(await openRedis(handed('app:prod')));
		const handle = await redis.queues.mails.add(to('a@b.c'), { id: 'j1' });
		const pending = settled(handle.finished());
		await subscribed(client(), 'queue:{app:prod:mails}:events');
		// Unprefixed, nobody listens: the pending finished must not hear it.
		await client().send('PUBLISH', [
			'queue:{mails}:events',
			JSON.stringify({
				type: 'completed',
				id: 'j1',
				result: { messageId: 'x' },
			}),
		]);
		const unheard = await client().send('PUBSUB', [
			'NUMSUB',
			'queue:{mails}:events',
		]);
		expect((unheard as unknown[])[1]).toBe(0);
		await client().send('PUBLISH', [
			'queue:{app:prod:mails}:events',
			JSON.stringify({
				type: 'completed',
				id: 'j1',
				result: { messageId: 'x' },
			}),
		]);
		expect(await pending).toEqual({ value: { messageId: 'x' } });
	});

	test('QueueError.queue stays unprefixed on a refused add under a prefix', async () => {
		const redis = track(await openRedis(handed('app:prod')));
		const refused = (await rejection(
			redis.queues.mails.add({ to: 1 } as never),
		)) as QueueError;
		expect(refused.code).toBe('INVALID');
		expect(refused.queue).toBe('mails');
		await redis.close();
		const closed = (await rejection(
			redis.queues.mails.add(to('a@b.c')),
		)) as QueueError;
		expect(closed.code).toBe('CLOSED');
		expect(closed.queue).toBe('mails');
	});
});

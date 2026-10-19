import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
import { complete } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const mails = () => bindQueue(client(), mailQueue);

describe('a paused claim', () => {
	test('reclaims and promotes but pops nothing, and leaves no wake token', async () => {
		const queue = mails();
		await queue.add({ to: 'lapsed' }, { id: 'lapsed' });
		await claim(client(), keys, 1, 30_000);
		await send('ZADD', keys.active, '1', 'lapsed');
		await queue.add({ to: 'due' }, { id: 'due', delay: 60_000 });
		await send('ZADD', keys.delayed, '1', 'due');
		await queue.add({ to: 'ready' }, { id: 'ready' });
		await send('LPUSH', keys.wake, '1');
		await queue.pause();

		const reply = await claim(client(), keys, 5, 30_000);

		expect(reply.jobs).toEqual([]);
		expect(reply.stalled).toEqual(['lapsed']);
		expect(reply.next).toBe(5_000);
		expect(await send('LLEN', keys.wake)).toBe(0);
		expect(await queue.counts()).toEqual({
			waiting: 3,
			delayed: 0,
			active: 0,
			completed: 0,
			failed: 0,
			paused: true,
		});
	});

	test('a settle while paused claims nothing next', async () => {
		const queue = mails();
		await queue.add({ to: 'a' }, { id: 'a' });
		await queue.add({ to: 'b' }, { id: 'b' });
		const [job] = (await claim(client(), keys, 1, 30_000)).jobs;
		if (!job) throw new Error('not claimed');
		await queue.pause();

		const reply = await complete(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			undefined,
			true,
		);

		expect(reply.settled).toBe(true);
		expect(reply.jobs).toEqual([]);
		expect(await send('LLEN', keys.wake)).toBe(0);
		expect(await client().hget(keys.job('b'), 'state')).toBe('waiting');
	});

	test('claims again once resumed', async () => {
		const queue = mails();
		await queue.add({ to: 'a' }, { id: 'a' });
		await queue.pause();
		await queue.resume();
		expect((await claim(client(), keys, 1, 30_000)).jobs).toHaveLength(1);
	});
});

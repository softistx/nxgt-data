import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { mailQueue, useChannelLog, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { queueKeys } from '../keys';
import { cancel } from './cancel';
import { claim } from './claim';
import { complete, fail } from './settle';

const servers = useRedis();
const channelLog = useChannelLog();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const mails = () => bindQueue(client(), mailQueue);
const listen = () => channelLog(client(), keys.events);

async function take(id: string) {
	await mails().add({ to: id }, { id });
	const job = (await claim(client(), keys, 1, 30_000)).jobs.find(
		(j) => j.id === id,
	);
	if (!job) throw new Error(`${id} was not claimed`);
	return job;
}

describe('cancel', () => {
	test('CANCEL removes a waiting job and publishes canceled', async () => {
		const log = await listen();
		await mails().add({ to: 'a' }, { id: 'a' });
		expect(await cancel(client(), keys, 'a')).toBe(true);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('ZSCORE', keys.ready, 'a')).toBeNull();
		expect(await log.published()).toEqual([{ type: 'canceled', id: 'a' }]);
	});

	test('CANCEL removes a delayed job', async () => {
		const log = await listen();
		await mails().add({ to: 'a' }, { id: 'a', delay: '1m' });
		expect(await cancel(client(), keys, 'a')).toBe(true);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('ZSCORE', keys.delayed, 'a')).toBeNull();
		expect(await log.published()).toEqual([{ type: 'canceled', id: 'a' }]);
	});

	test('CANCEL of an active job drops its token, so its COMPLETE is refused and publishes nothing', async () => {
		const log = await listen();
		const job = await take('a');
		expect(await cancel(client(), keys, 'a')).toBe(true);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('ZSCORE', keys.active, 'a')).toBeNull();
		const late = await complete(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			'1',
			false,
		);
		expect(late.settled).toBe(false);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('ZCARD', keys.completed)).toBe(0);
		expect(await log.published()).toEqual([{ type: 'canceled', id: 'a' }]);
	});

	test('CANCEL of a completed or failed job answers 0 and publishes nothing', async () => {
		const log = await listen();
		const done = await take('done');
		await complete(
			client(),
			keys,
			mailQueue,
			'done',
			done.token,
			undefined,
			false,
		);
		const broke = await take('broke');
		await fail(
			client(),
			keys,
			mailQueue,
			'broke',
			broke.token,
			{ name: 'x', message: 'boom' },
			null,
			false,
		);
		const before = await log.published();
		expect(await cancel(client(), keys, 'done')).toBe(false);
		expect(await cancel(client(), keys, 'broke')).toBe(false);
		expect(await cancel(client(), keys, 'ghost')).toBe(false);
		expect(await log.published()).toEqual(before);
		expect(await send('HGET', keys.job('done'), 'state')).toBe('completed');
		expect(await send('HGET', keys.job('broke'), 'state')).toBe('failed');
		expect(await send('ZCARD', keys.completed)).toBe(1);
		expect(await send('ZCARD', keys.failed)).toBe(1);
	});

	test('a hash that disagrees with its set is left alone', async () => {
		const log = await listen();
		await mails().add({ to: 'a' }, { id: 'a' });
		await send('HSET', keys.job('a'), 'state', 'completed');
		expect(await cancel(client(), keys, 'a')).toBe(false);
		expect(await send('ZSCORE', keys.ready, 'a')).not.toBeNull();
		expect(await send('EXISTS', keys.job('a'))).toBe(1);
		expect(await log.published()).toEqual([]);
	});

	test('a hash whose id is in no set is left alone', async () => {
		const log = await listen();
		await mails().add({ to: 'a' }, { id: 'a' });
		await send('ZREM', keys.ready, 'a');
		expect(await cancel(client(), keys, 'a')).toBe(false);
		expect(await send('EXISTS', keys.job('a'))).toBe(1);
		expect(await log.published()).toEqual([]);
	});

	test('CANCEL racing COMPLETE: exactly one outcome is published', async () => {
		const log = await listen();
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepCompleted: false,
		});
		const first = await take('first');
		expect(await cancel(client(), keys, 'first')).toBe(true);
		expect(
			(await complete(client(), keys, queue, 'first', first.token, '1', false))
				.settled,
		).toBe(false);
		const second = await take('second');
		expect(
			(
				await complete(
					client(),
					keys,
					queue,
					'second',
					second.token,
					'2',
					false,
				)
			).settled,
		).toBe(true);
		expect(await cancel(client(), keys, 'second')).toBe(false);
		const third = await take('third');
		const [canceled, completed] = await Promise.all([
			cancel(client(), keys, 'third'),
			complete(client(), keys, queue, 'third', third.token, '3', false),
		]);
		expect(canceled).toBe(!completed.settled);
		const outcomes = (await log.published()) as {
			type: string;
			id: string;
			result?: number;
		}[];
		expect(outcomes.filter((o) => o.id === 'third')).toHaveLength(1);
		expect(outcomes.filter((o) => o.id !== 'third')).toEqual([
			{ type: 'canceled', id: 'first' },
			{ type: 'completed', id: 'second', result: 2 },
		]);
	});
});

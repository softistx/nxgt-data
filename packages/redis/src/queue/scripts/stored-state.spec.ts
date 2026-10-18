import { describe, expect, test } from 'bun:test';
import { mailQueue, useChannelLog, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';

const servers = useRedis();
const channelLog = useChannelLog();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

describe('stored state', () => {
	test('a hash missing data or with a non-numeric attempt is failed with INVALID, not run', async () => {
		await send(
			'HSET',
			keys.job('nodata'),
			'priority',
			'0',
			'attempt',
			'0',
			'attempts',
			'3',
		);
		await send(
			'HSET',
			keys.job('nan'),
			'data',
			'{}',
			'priority',
			'0',
			'attempt',
			'soon',
			'attempts',
			'3',
		);
		await send('ZADD', keys.ready, '1', 'nodata');
		await send('ZADD', keys.ready, '2', 'nan');
		await bindQueue(client(), mailQueue).add({ to: 'ok' }, { id: 'ok' });
		const reply = await claim(client(), keys, 5, 30_000);
		expect(reply.jobs.map((j) => j.id)).toEqual(['ok']);
		expect(reply.failedInvalid.sort()).toEqual(['nan', 'nodata']);
		for (const id of ['nodata', 'nan']) {
			expect(await hget(id, 'state')).toBe('failed');
			expect(JSON.parse((await hget(id, 'error')) ?? '')).toEqual({
				name: 'QueueError',
				message: 'INVALID: a stored job this package could not have written',
			});
			expect(await send('ZSCORE', keys.failed, id)).not.toBeNull();
			expect(await send('ZSCORE', keys.ready, id)).toBeNull();
		}
	});

	test.each([
		['attempts', 'inf'],
		['priority', '5000'],
		['priority', 'inf'],
		['attempt', '1.5'],
		['attempt', '-4'],
		['attempts', '0x10'],
		['attempts', '0'],
		['timeout', 'inf'],
		['timeout', '0'],
		['timeout', '1.5'],
		['timeout', '-4'],
		['timeout', '1e3'],
		['timeout', ''],
		// Longer than 15 digits: past what a double holds exactly, and a 20-digit
		// value turns into garbage or a negative number in Lua.
		['timeout', '9'.repeat(16)],
		['timeout', '9'.repeat(20)],
	])('%s = %s is failed with INVALID, not claimed', async (field, value) => {
		const fields: Record<string, string> = {
			data: '{}',
			priority: '0',
			attempt: '0',
			attempts: '3',
			[field]: value,
		};
		await send('HSET', keys.job('odd'), ...Object.entries(fields).flat());
		await send('ZADD', keys.ready, '1', 'odd');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs).toEqual([]);
		expect(reply.failedInvalid).toEqual(['odd']);
		expect(await hget('odd', 'state')).toBe('failed');
	});

	test('a hash with timeout "inf" is failed INVALID at claim, and one with a whole timeout is claimed', async () => {
		for (const [id, timeout] of [
			['bad', 'inf'],
			['good', '1500'],
			['long', '9'.repeat(15)],
		] as const) {
			await send(
				'HSET',
				keys.job(id),
				'data',
				'{}',
				'priority',
				'0',
				'attempt',
				'0',
				'attempts',
				'3',
				'timeout',
				timeout,
			);
			await send('ZADD', keys.ready, '1', id);
		}
		const reply = await claim(client(), keys, 5, 30_000);
		expect(reply.failedInvalid).toEqual(['bad']);
		expect(reply.jobs.map((j) => [j.id, j.timeout])).toEqual([
			['good', 1500],
			['long', 999_999_999_999_999],
		]);
	});

	test('the longest timeout add takes is stored at the timer cap, and claimed', async () => {
		await bindQueue(client(), mailQueue).add(
			{ to: 'a' },
			{ id: 'a', timeout: Number.MAX_SAFE_INTEGER },
		);
		expect(await hget('a', 'timeout')).toBe('2147483647');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs.map((j) => [j.id, j.timeout])).toEqual([
			['a', 2_147_483_647],
		]);
	});

	test('a hash with extra fields is still claimed', async () => {
		await send(
			'HSET',
			keys.job('x'),
			'data',
			'{}',
			'priority',
			'0',
			'attempt',
			'0',
			'attempts',
			'3',
			'step:charge',
			'"done"',
			'progress',
			'40',
			'group',
			'g1',
		);
		await send('ZADD', keys.ready, '1', 'x');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs.map((j) => j.id)).toEqual(['x']);
		expect(reply.failedInvalid).toEqual([]);
	});

	test('an id in ready with no hash is dropped', async () => {
		await send('ZADD', keys.ready, '1', 'ghost');
		const reply = await claim(client(), keys, 5, 30_000);
		expect(reply.jobs).toEqual([]);
		expect(reply.failedInvalid).toEqual([]);
		expect(reply.stalled).toEqual([]);
		expect(await send('ZCARD', keys.ready)).toBe(0);
		expect(await send('ZCARD', keys.failed)).toBe(0);
	});

	test('a job failed INVALID at claim publishes the failure', async () => {
		const log = await channelLog(client(), keys.events);
		await send('HSET', keys.job('odd'), 'data', '{}', 'attempt', 'x');
		await send('ZADD', keys.ready, '1', 'odd');
		await send('ZADD', keys.ready, '2', 'ghost');
		await claim(client(), keys, 2, 30_000);
		expect(await log.published()).toEqual([
			{
				type: 'failed',
				id: 'odd',
				error: {
					name: 'QueueError',
					message: 'INVALID: a stored job this package could not have written',
				},
			},
		]);
	});

	test('an untrusted lapsed lease is failed with INVALID, not retried', async () => {
		await send('HSET', keys.job('odd'), 'data', '{}', 'attempt', 'x');
		await send('ZADD', keys.active, '1', 'odd');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.failedInvalid).toEqual(['odd']);
		expect(await hget('odd', 'state')).toBe('failed');
	});
});

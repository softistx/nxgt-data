import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';

const servers = useRedis();
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

	test('an untrusted lapsed lease is failed with INVALID, not retried', async () => {
		await send('HSET', keys.job('odd'), 'data', '{}', 'attempt', 'x');
		await send('ZADD', keys.active, '1', 'odd');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.failedInvalid).toEqual(['odd']);
		expect(await hget('odd', 'state')).toBe('failed');
	});
});

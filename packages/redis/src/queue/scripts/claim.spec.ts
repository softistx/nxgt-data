import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';

const servers = useRedis();
const keys = queueKeys('mails');
const to = (address: string) => ({ to: address });
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const hget = (id: string, field: string) => client().hget(keys.job(id), field);
const mails = () => bindQueue(client(), mailQueue);

describe('claim', () => {
	test('claims by priority, sets active with a lease from the server clock', async () => {
		await mails().add(to('low'), { id: 'low', priority: 5 });
		await mails().add(to('urgent'), { id: 'urgent', priority: 0 });
		const [seconds, micros] = (await send('TIME')) as [string, string];
		const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs).toHaveLength(1);
		const job = reply.jobs[0];
		expect(job?.id).toBe('urgent');
		expect(JSON.parse(job?.data ?? '')).toEqual({
			to: 'urgent',
			template: 'welcome',
		});
		expect(job?.attempt).toBe(1);
		expect(job?.attempts).toBe(3);
		expect(job?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(await hget('urgent', 'state')).toBe('active');
		expect(await hget('urgent', 'token')).toBe(job?.token ?? '');
		expect(await hget('urgent', 'attempt')).toBe('1');
		const lease = Number(await send('ZSCORE', keys.active, 'urgent'));
		expect(lease).toBeGreaterThanOrEqual(now + 29_000);
		expect(lease).toBeLessThanOrEqual(now + 31_000);
		expect(await send('ZSCORE', keys.ready, 'urgent')).toBeNull();
		expect(reply.next).toBe(-1);
	});

	test('claims at most n, and pushes a wake token when ready is left non-empty', async () => {
		for (const id of ['a', 'b', 'c']) await mails().add(to(id), { id });
		await send('DEL', keys.wake);
		const first = await claim(client(), keys, 2, 30_000);
		expect(first.jobs.map((j) => j.id)).toEqual(['a', 'b']);
		expect(new Set(first.jobs.map((j) => j.token)).size).toBe(2);
		expect(await send('LLEN', keys.wake)).toBe(1);
		await send('DEL', keys.wake);
		const last = await claim(client(), keys, 2, 30_000);
		expect(last.jobs.map((j) => j.id)).toEqual(['c']);
		expect(await send('LLEN', keys.wake)).toBe(0);
	});

	test('promotes due delayed jobs, and reports the ms to the next one', async () => {
		await mails().add(to('due'), { id: 'due', delay: 50 });
		await mails().add(to('later'), { id: 'later', delay: '1m' });
		expect((await claim(client(), keys, 5, 30_000)).jobs).toEqual([]);
		await Bun.sleep(80);
		const reply = await claim(client(), keys, 5, 30_000);
		expect(reply.jobs.map((j) => j.id)).toEqual(['due']);
		expect(reply.next).toBeGreaterThan(58_000);
		expect(reply.next).toBeLessThanOrEqual(60_000);
		expect(await hget('later', 'state')).toBe('delayed');
	});

	test('a promoted job gets its ready score from its stored priority', async () => {
		await mails().add(to('p'), { id: 'p', priority: 7, delay: 10 });
		await Bun.sleep(30);
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs.map((j) => j.id)).toEqual(['p']);
	});

	test('reclaims a lapsed lease as an attempt', async () => {
		await mails().add(to('x'), { id: 'x', priority: 3 });
		const first = await claim(client(), keys, 1, 30_000);
		await send('ZADD', keys.active, '1', 'x');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toEqual(['x']);
		// reclaimed, then claimed again in the same script: attempt 2
		expect(reply.jobs[0]?.attempt).toBe(2);
		expect(reply.jobs[0]?.token).not.toBe(first.jobs[0]?.token);
		expect(await hget('x', 'attempt')).toBe('2');
	});

	test('a reclaimed job returns to ready, scored from its priority and a fresh seq', async () => {
		await mails().add(to('x'), { id: 'x', priority: 3 });
		await claim(client(), keys, 1, 30_000);
		await send('ZADD', keys.active, '1', 'x');
		// n = 1 would claim it again at once; ask the script for the state
		// between with a second job taking the only slot
		await mails().add(to('y'), { id: 'y', priority: 0 });
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toEqual(['x']);
		expect(reply.jobs.map((j) => j.id)).toEqual(['y']);
		expect(await hget('x', 'state')).toBe('waiting');
		expect(await hget('x', 'token')).toBeNull();
		expect(await send('ZSCORE', keys.active, 'x')).toBeNull();
		const score = Number(await send('ZSCORE', keys.ready, 'x'));
		expect(score).toBe(3 * 2 ** 40 + 3);
		expect(Number.isInteger(score)).toBe(true);
	});

	test('a lapsed lease on the last attempt fails with "lease lapsed"', async () => {
		await mails().add(to('x'), { id: 'x' });
		await claim(client(), keys, 1, 30_000);
		await send('HSET', keys.job('x'), 'attempt', '3');
		await send('ZADD', keys.active, '1', 'x');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toEqual(['x']);
		expect(reply.jobs).toEqual([]);
		expect(await hget('x', 'state')).toBe('failed');
		expect(JSON.parse((await hget('x', 'error')) ?? '')).toEqual({
			name: 'LeaseLapsed',
			message: 'lease lapsed',
		});
		expect(await send('ZSCORE', keys.failed, 'x')).not.toBeNull();
		expect(await send('ZSCORE', keys.active, 'x')).toBeNull();
		expect(await hget('x', 'token')).toBeNull();
	});

	test('reclaims at most 100 lapsed leases per call', async () => {
		for (let i = 0; i < 120; i += 1) {
			await send(
				'HSET',
				keys.job(`j${i}`),
				'data',
				'{}',
				'priority',
				'0',
				'attempt',
				'1',
				'attempts',
				'3',
				'state',
				'active',
				'token',
				't',
			);
			await send('ZADD', keys.active, '1', `j${i}`);
		}
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toHaveLength(100);
		expect(await send('ZCARD', keys.active)).toBe(20 + 1);
	});

	test('a lease ending soon is left alone, one that lapsed a second ago is taken back', async () => {
		for (const id of ['soon', 'gone']) {
			await send(
				'HSET',
				keys.job(id),
				'data',
				'{}',
				'priority',
				'0',
				'attempt',
				'1',
				'attempts',
				'3',
				'state',
				'active',
				'token',
				't',
			);
		}
		const [seconds] = (await send('TIME')) as [string, string];
		const now = Number(seconds) * 1000;
		await send('ZADD', keys.active, String(now + 5_000), 'soon');
		await send('ZADD', keys.active, String(now - 1_000), 'gone');
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toEqual(['gone']);
		expect(await hget('soon', 'token')).toBe('t');
	});

	test('promotes at most 1000 due jobs per call, and says the rest is due now', async () => {
		for (let i = 0; i < 1_001; i += 1) {
			await send(
				'HSET',
				keys.job(`d${i}`),
				'data',
				'{}',
				'priority',
				'0',
				'attempt',
				'0',
				'attempts',
				'3',
				'state',
				'delayed',
			);
			await send('ZADD', keys.delayed, '1', `d${i}`);
		}
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.jobs).toHaveLength(1);
		expect(await send('ZCARD', keys.delayed)).toBe(1);
		expect(await send('ZCARD', keys.ready)).toBe(999);
		expect(reply.next).toBe(0);
	});

	test('a lease that has not lapsed is left alone', async () => {
		await mails().add(to('x'), { id: 'x' });
		await claim(client(), keys, 1, 30_000);
		const reply = await claim(client(), keys, 1, 30_000);
		expect(reply.stalled).toEqual([]);
		expect(await hget('x', 'attempt')).toBe('1');
	});
});

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { mailQueue, scriptCalls, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
import { renew } from './renew';
import { complete, fail } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const hget = (id: string, field: string) => client().hget(keys.job(id), field);
const to = (address: string) => ({ to: address });
const boundary = { name: 'x', message: 'boom' };

async function take(id: string, queue = mailQueue) {
	await bindQueue(client(), queue).add(to(id), { id });
	const reply = await claim(client(), keys, 1, 30_000);
	const job = reply.jobs.find((j) => j.id === id);
	if (!job) throw new Error(`${id} was not claimed`);
	return job;
}

describe('complete', () => {
	test('complete with the wrong token changes nothing', async () => {
		const job = await take('a');
		const reply = await complete(
			client(),
			keys,
			mailQueue,
			'a',
			'0'.repeat(32),
			false,
		);
		expect(reply.settled).toBe(false);
		expect(await hget('a', 'state')).toBe('active');
		expect(await hget('a', 'token')).toBe(job.token);
		expect(await send('ZSCORE', keys.active, 'a')).not.toBeNull();
		expect(await send('ZCARD', keys.completed)).toBe(0);
	});

	test('complete for an unknown id changes nothing', async () => {
		const reply = await complete(
			client(),
			keys,
			mailQueue,
			'ghost',
			'a',
			false,
		);
		expect(reply.settled).toBe(false);
		expect(await send('EXISTS', keys.job('ghost'))).toBe(0);
	});

	test('complete moves the job to completed and removes its token', async () => {
		const job = await take('a');
		const reply = await complete(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			false,
		);
		expect(reply).toEqual({
			settled: true,
			jobs: [],
			stalled: [],
			failedInvalid: [],
			next: -1,
		});
		expect(await hget('a', 'state')).toBe('completed');
		expect(await hget('a', 'token')).toBeNull();
		expect(Number(await hget('a', 'finished'))).toBeGreaterThan(0);
		expect(await send('ZSCORE', keys.active, 'a')).toBeNull();
		expect(await send('ZSCORE', keys.completed, 'a')).not.toBeNull();
	});

	test('complete keeps the job in completed, trimmed by count', async () => {
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepCompleted: { count: 2 },
		});
		for (const id of ['a', 'b', 'c']) {
			const job = await take(id, queue as never);
			await complete(client(), keys, queue, id, job.token, false);
			await Bun.sleep(5);
		}
		expect(await send('ZCARD', keys.completed)).toBe(2);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('EXISTS', keys.job('b'))).toBe(1);
		expect(await send('EXISTS', keys.job('c'))).toBe(1);
	});

	test('complete trims completed jobs older than the age, and deletes their hashes', async () => {
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepCompleted: { age: 50, count: 100 },
		});
		const old = await take('old', queue as never);
		await complete(client(), keys, queue, 'old', old.token, false);
		await Bun.sleep(80);
		const fresh = await take('fresh', queue as never);
		await complete(client(), keys, queue, 'fresh', fresh.token, false);
		expect(await send('EXISTS', keys.job('old'))).toBe(0);
		expect(await send('ZSCORE', keys.completed, 'old')).toBeNull();
		expect(await send('ZCARD', keys.completed)).toBe(1);
	});

	test('a trim removes at most 100 per call', async () => {
		for (let i = 0; i < 130; i += 1) {
			await send('HSET', keys.job(`o${i}`), 'state', 'completed');
			await send('ZADD', keys.completed, String(i + 1), `o${i}`);
		}
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepCompleted: { age: 1000, count: 1000 },
		});
		const job = await take('fresh', queue as never);
		await complete(client(), keys, queue, 'fresh', job.token, false);
		expect(await send('ZCARD', keys.completed)).toBe(130 + 1 - 100);
	});

	test('keepCompleted false deletes at once', async () => {
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepCompleted: false,
		});
		const job = await take('a', queue as never);
		const reply = await complete(client(), keys, queue, 'a', job.token, false);
		expect(reply.settled).toBe(true);
		expect(await send('EXISTS', keys.job('a'))).toBe(0);
		expect(await send('ZCARD', keys.completed)).toBe(0);
		expect(await send('ZCARD', keys.active)).toBe(0);
	});

	test('complete with claimNext returns the next job in the same script', async () => {
		const bound = bindQueue(client(), mailQueue);
		await bound.add(to('a'), { id: 'a' });
		await bound.add(to('b'), { id: 'b' });
		const first = (await claim(client(), keys, 1, 30_000)).jobs[0];
		const before = await scriptCalls(client());
		const reply = await complete(
			client(),
			keys,
			mailQueue,
			'a',
			first?.token ?? '',
			true,
		);
		expect(await scriptCalls(client())).toBe(before + 1);
		expect(reply.settled).toBe(true);
		expect(reply.jobs.map((j) => j.id)).toEqual(['b']);
		expect(reply.jobs[0]?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(await hget('b', 'state')).toBe('active');
	});

	test('a mismatched settle claims nothing even with claimNext', async () => {
		const bound = bindQueue(client(), mailQueue);
		await bound.add(to('a'), { id: 'a' });
		await bound.add(to('b'), { id: 'b' });
		await claim(client(), keys, 1, 30_000);
		const reply = await complete(client(), keys, mailQueue, 'a', 'nope', true);
		expect(reply.settled).toBe(false);
		expect(reply.jobs).toEqual([]);
		expect(await hget('b', 'state')).toBe('waiting');
	});
});

describe('fail', () => {
	test('fail retries into delayed while attempts remain, then fails for good', async () => {
		let job = await take('a');
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const reply = await fail(
				client(),
				keys,
				mailQueue,
				'a',
				job.token,
				boundary,
				40,
				false,
			);
			expect(reply.settled).toBe(true);
			expect(reply.final).toBe(false);
			expect(await hget('a', 'state')).toBe('delayed');
			expect(await hget('a', 'token')).toBeNull();
			expect(JSON.parse((await hget('a', 'error')) ?? '')).toEqual(boundary);
			expect(await send('ZSCORE', keys.delayed, 'a')).not.toBeNull();
			expect(await send('ZSCORE', keys.active, 'a')).toBeNull();
			await Bun.sleep(60);
			const next = (await claim(client(), keys, 1, 30_000)).jobs[0];
			expect(next?.attempt).toBe(attempt + 1);
			job = next ?? job;
		}
		const last = await fail(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			boundary,
			40,
			false,
		);
		expect(last.final).toBe(true);
		expect(await hget('a', 'state')).toBe('failed');
		expect(await send('ZSCORE', keys.failed, 'a')).not.toBeNull();
		expect(Number(await hget('a', 'finished'))).toBeGreaterThan(0);
	});

	test('fail with retryInMs null fails at once', async () => {
		const job = await take('a');
		const reply = await fail(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			boundary,
			null,
			false,
		);
		expect(reply.final).toBe(true);
		expect(await hget('a', 'state')).toBe('failed');
		expect(await send('ZCARD', keys.delayed)).toBe(0);
	});

	test('fail with a retry in 0 ms still retries', async () => {
		const job = await take('a');
		const reply = await fail(
			client(),
			keys,
			mailQueue,
			'a',
			job.token,
			boundary,
			0,
			false,
		);
		expect(reply.final).toBe(false);
		expect(await hget('a', 'state')).toBe('delayed');
	});

	test('fail with the wrong token changes nothing', async () => {
		const job = await take('a');
		const reply = await fail(
			client(),
			keys,
			mailQueue,
			'a',
			'f'.repeat(32),
			boundary,
			null,
			false,
		);
		expect(reply.settled).toBe(false);
		expect(reply.final).toBe(false);
		expect(await hget('a', 'state')).toBe('active');
		expect(await hget('a', 'token')).toBe(job.token);
	});

	test('a failed job older than keepFailed is trimmed, with its hash', async () => {
		const queue = defineQueue({
			name: 'mails',
			schema: z.object({ to: z.string() }),
			keepFailed: 50,
		});
		const old = await take('old', queue as never);
		await fail(client(), keys, queue, 'old', old.token, boundary, null, false);
		await Bun.sleep(80);
		const fresh = await take('fresh', queue as never);
		await fail(
			client(),
			keys,
			queue,
			'fresh',
			fresh.token,
			boundary,
			null,
			false,
		);
		expect(await send('EXISTS', keys.job('old'))).toBe(0);
		expect(await send('ZCARD', keys.failed)).toBe(1);
	});

	test('fail with claimNext returns the next job in the same script', async () => {
		const bound = bindQueue(client(), mailQueue);
		await bound.add(to('a'), { id: 'a' });
		await bound.add(to('b'), { id: 'b' });
		const first = (await claim(client(), keys, 1, 30_000)).jobs[0];
		const before = await scriptCalls(client());
		const reply = await fail(
			client(),
			keys,
			mailQueue,
			'a',
			first?.token ?? '',
			boundary,
			null,
			true,
		);
		expect(await scriptCalls(client())).toBe(before + 1);
		expect(reply.jobs.map((j) => j.id)).toEqual(['b']);
	});
});

describe('renew', () => {
	test('renews only the entries whose token holds, and returns the lost ones', async () => {
		const a = await take('a');
		const b = await take('b');
		await send('ZADD', keys.active, '5000', 'a');
		await send('ZADD', keys.active, '5000', 'b');
		const lost = await renew(client(), keys, 30_000, [
			{ id: 'a', token: a.token },
			{ id: 'b', token: '0'.repeat(32) },
			{ id: 'ghost', token: b.token },
		]);
		expect(lost.sort()).toEqual(['b', 'ghost']);
		expect(Number(await send('ZSCORE', keys.active, 'a'))).toBeGreaterThan(
			Date.now() + 25_000,
		);
		expect(Number(await send('ZSCORE', keys.active, 'b'))).toBe(5000);
		expect(await send('ZSCORE', keys.active, 'ghost')).toBeNull();
	});

	test('renew does not put back a lease that is gone', async () => {
		const a = await take('a');
		await send('ZREM', keys.active, 'a');
		await renew(client(), keys, 30_000, [{ id: 'a', token: a.token }]);
		expect(await send('ZSCORE', keys.active, 'a')).toBeNull();
	});

	test('renew with no entries returns nothing', async () => {
		expect(await renew(client(), keys, 30_000, [])).toEqual([]);
	});
});

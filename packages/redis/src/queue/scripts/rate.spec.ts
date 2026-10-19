import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { checkRate } from '../../rate-limit/gcra';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { claim } from './claim/claim';
import { complete, fail } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const mails = () => bindQueue(client(), mailQueue);

const TWO = { limit: 2, per: 1000, burst: 2 };

async function addMany(n: number): Promise<void> {
	for (let i = 0; i < n; i++)
		await mails().add({ to: `j${i}` }, { id: `j${i}` });
}

describe('a claim under a queue rate', () => {
	test('admits at most the rate and charges what it popped', async () => {
		await addMany(5);
		const first = await claim(client(), keys, 5, 30_000, TWO);
		expect(first.jobs).toHaveLength(2);
		expect(await send('LLEN', keys.wake)).toBe(0);

		const second = await claim(client(), keys, 5, 30_000, TWO);
		const refused = await checkRate(client(), keys.rate, TWO, 1, false);
		expect(second.jobs).toEqual([]);
		expect(second.next).toBeGreaterThan(0);
		// 2 a second: one job's worth is 500 ms, and a little time has passed.
		expect(second.next).toBeLessThanOrEqual(500);
		expect(refused.retryAfter).toBeLessThanOrEqual(500);
		expect(await send('LLEN', keys.wake)).toBe(0);
		expect(await send('ZCARD', keys.ready)).toBe(3);
	});

	test('a claim that pops fewer than admitted charges only what it popped', async () => {
		const five = { limit: 5, per: 60_000, burst: 5 };
		await addMany(1);
		expect((await claim(client(), keys, 5, 30_000, five)).jobs).toHaveLength(1);
		expect(
			(await checkRate(client(), keys.rate, five, 0, false)).remaining,
		).toBe(4);
	});

	test('a reclaimed lease is not charged', async () => {
		const five = { limit: 5, per: 60_000, burst: 5 };
		await addMany(1);
		await claim(client(), keys, 1, 30_000, five);
		await send('ZADD', keys.active, '1', 'j0');

		const reply = await claim(client(), keys, 0, 30_000, five);

		expect(reply.stalled).toEqual(['j0']);
		expect(reply.jobs).toEqual([]);
		expect(
			(await checkRate(client(), keys.rate, five, 0, false)).remaining,
		).toBe(4);
	});

	test('no rateLimit, no rate key written', async () => {
		await addMany(2);
		expect(
			(await claim(client(), keys, 2, 30_000, undefined)).jobs,
		).toHaveLength(2);
		expect(await send('EXISTS', keys.rate)).toBe(0);
	});

	test('the claim body refuses a rate state it could not have written as defineRateLimit does', async () => {
		const ten = { limit: 10, per: 1000, burst: 10 };
		await addMany(1);
		await client().set(keys.rate, '1 99999999999999999999');
		const started = performance.now();
		const reply = await claim(client(), keys, 1, 30_000, ten);
		expect(reply.jobs).toHaveLength(1);
		expect(performance.now() - started).toBeLessThan(100);
		expect(await client().get(keys.rate)).toMatch(/^\d+ 1000000$/);
		expect(await client().pttl(keys.rate)).toBeGreaterThan(0);
	}, 1000);

	test.each(['complete', 'fail'])(
		'a %s that claims next claims under the same rate',
		async (how) => {
			const one = { limit: 1, per: 60_000, burst: 1 };
			const limited = { ...mailQueue, rateLimit: one };
			await addMany(2);
			const [job] = (await claim(client(), keys, 1, 30_000, one)).jobs;
			if (!job) throw new Error('not claimed');
			const reply =
				how === 'complete'
					? await complete(
							client(),
							keys,
							limited,
							job.id,
							job.token,
							undefined,
							true,
						)
					: await fail(
							client(),
							keys,
							limited,
							job.id,
							job.token,
							{ name: 'E', message: 'm' },
							null,
							true,
						);
			expect(reply.settled).toBe(true);
			expect(reply.jobs).toEqual([]);
			expect(reply.next).toBeGreaterThan(0);
			expect(await send('LLEN', keys.wake)).toBe(0);
			expect(await send('ZCARD', keys.ready)).toBe(1);
		},
	);
});

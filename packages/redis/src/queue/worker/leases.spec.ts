import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import {
	eventually,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { claim } from '../scripts/claim/claim';
import { keepLeases } from './leases';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const score = async (id: string) =>
	Number(await client().send('ZSCORE', [keys.active, id]));

describe('keepLeases', () => {
	test('renews every third of the lease in one script for all jobs', async () => {
		const queue = bindQueue(client(), mailQueue);
		await queue.add({ to: 'a' }, { id: 'a' });
		await queue.add({ to: 'b' }, { id: 'b' });
		const { jobs } = await claim(client(), keys, 2, mailQueue.lease, undefined);
		const first = Number(await score('a'));
		const calls = await scriptCalls(client());
		const leases = keepLeases(client(), keys, mailQueue.lease, () => {
			throw new Error('nothing was lost');
		});
		for (const job of jobs) leases.add(job.id, job.token);
		await Bun.sleep(450);
		leases.stop();
		// Without renewals both leases would have lapsed at `first`.
		expect(await score('a')).toBeGreaterThan(first + 200);
		expect(await score('b')).toBeGreaterThan(first + 200);
		const spent = (await scriptCalls(client())) - calls;
		expect(spent).toBeGreaterThanOrEqual(3);
		expect(spent).toBeLessThanOrEqual(5); // 4 beats, not 8
	});

	test('reports the ids whose token was taken', async () => {
		const queue = bindQueue(client(), mailQueue);
		await queue.add({ to: 'a' }, { id: 'a' });
		await queue.add({ to: 'b' }, { id: 'b' });
		const { jobs } = await claim(client(), keys, 2, mailQueue.lease, undefined);
		const lost: string[][] = [];
		const leases = keepLeases(client(), keys, mailQueue.lease, (entries) =>
			lost.push(entries.map((e) => e.id)),
		);
		leases.add('a', 'not-the-token');
		leases.add('b', jobs.find((j) => j.id === 'b')?.token ?? '');
		await Bun.sleep(250);
		leases.stop();
		expect(lost).toEqual([['a']]);
	});

	test('an entry claimed again under a new token survives a renewal in flight for the old one', async () => {
		// A fake client, so the reply of the first renewal can be held.
		const calls: unknown[][] = [];
		const replies: ((lost: string[]) => void)[] = [];
		const fake = {
			evalsha: (...args: unknown[]) => {
				calls.push(args);
				return new Promise<string[]>((resolve) => replies.push(resolve));
			},
		} as unknown as RedisClient;
		const lost: string[][] = [];
		const leases = keepLeases(fake, keys, 30, (entries) =>
			lost.push(entries.map((e) => e.id)),
		);
		leases.add('a', 'old');
		// The beat goes on while this one is held: wait for it, not for an exact count.
		await eventually(() => calls.length >= 1, true);
		// The job was settled and claimed again while the renewal was in flight.
		leases.delete('a', 'old');
		leases.add('a', 'new');
		const sent = calls.length; // renewals sent so far carry the old token or none
		replies[0]?.(['a']); // Redis: the old token no longer holds
		await Bun.sleep(5);
		expect(lost).toEqual([]);
		await eventually(() => calls.length > sent, true);
		expect(calls[sent]).toContain('new');
		leases.stop();
	});

	test("a finished stale run does not end the new run's renewals", async () => {
		const calls: unknown[][] = [];
		const fake = {
			evalsha: (...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve([] as string[]);
			},
		} as unknown as RedisClient;
		const leases = keepLeases(fake, keys, 30, () => undefined);
		leases.add('a', 't1');
		leases.add('a', 't2'); // claimed again, while the first run still goes on
		leases.delete('a', 't1'); // the first run settles late
		await eventually(() => calls.length > 0, true);
		expect(calls.every((call) => call.includes('t2'))).toBe(true);
		expect(calls.some((call) => call.includes('t1'))).toBe(false);
		const before = calls.length;
		leases.delete('a', 't2'); // the current run's own end does stop them
		await Bun.sleep(30);
		expect(calls.length).toBeLessThanOrEqual(before + 1);
		leases.stop();
	});
});

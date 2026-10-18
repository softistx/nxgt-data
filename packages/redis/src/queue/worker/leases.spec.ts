import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import {
	eventually,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
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
		const { jobs } = await claim(client(), keys, 2, mailQueue.lease);
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
		const { jobs } = await claim(client(), keys, 2, mailQueue.lease);
		const lost: string[][] = [];
		const leases = keepLeases(client(), keys, mailQueue.lease, (ids) =>
			lost.push(ids),
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
		const leases = keepLeases(fake, keys, 30, (ids) => lost.push(ids));
		leases.add('a', 'old');
		await eventually(() => calls.length, 1);
		// The job was settled and claimed again while the renewal was in flight.
		leases.delete('a');
		leases.add('a', 'new');
		replies[0]?.(['a']); // Redis: the old token no longer holds
		await Bun.sleep(5);
		expect(lost).toEqual([]);
		await eventually(() => calls.length > 1, true);
		expect(calls[1]).toContain('new');
		leases.stop();
	});
});

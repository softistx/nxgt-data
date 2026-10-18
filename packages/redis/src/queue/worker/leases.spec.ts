import { describe, expect, test } from 'bun:test';
import { mailQueue, scriptCalls, useRedis } from '../../../test/fixtures';
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
});

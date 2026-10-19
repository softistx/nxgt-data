import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
	blocked,
	eventually,
	scriptCalls,
	useClients,
	useRedis,
} from '../../../test/fixtures';
import { bindQueue } from '../binding/bind-queue';
import { queueKeys } from '../binding/keys';
import { defineQueue } from '../definition/define-queue';
import { claim } from '../scripts/claim/claim';
import type { Worker } from './types';

const servers = useRedis();
const keys = queueKeys('limited');
const client = () => servers.redis.client;
const clients = useClients(servers);
// Two a minute, a burst of two: one more only after 30 s, so a count of two
// stays two for the whole spec.
const limited = defineQueue({
	name: 'limited',
	schema: z.object({ n: z.number() }),
	rateLimit: { limit: 2, per: '1m' },
});
const queue = () => bindQueue(client(), limited);

const opened: Worker[] = [];
afterEach(async () => {
	for (const worker of opened.splice(0)) await worker.close();
});

describe('a rate-limited queue', () => {
	test('two workers share one rate', async () => {
		const q = queue();
		await q.addMany(Array.from({ length: 6 }, (_, n) => ({ data: { n } })));
		const ran: number[] = [];
		for (const own of clients()) {
			opened.push(
				bindQueue(own, limited).work(
					(job) => {
						ran.push(job.data.n);
					},
					{ concurrency: 3 },
				),
			);
		}
		await eventually(async () => (await q.counts()).completed, 2);
		await Bun.sleep(300);
		expect(ran).toHaveLength(2);
		expect(await q.counts()).toMatchObject({ completed: 2, waiting: 4 });
	});

	test('a rate-limited queue does not spin', async () => {
		const q = queue();
		await q.addMany(Array.from({ length: 4 }, (_, n) => ({ data: { n } })));
		// Loads CLAIM in the server's cache: a cold EVALSHA costs two calls.
		await claim(client(), keys, 0, 30_000, undefined);
		for (let i = 0; i < 2; i++) opened.push(q.work(() => undefined));
		await eventually(async () => (await q.counts()).completed, 2);
		await blocked(client(), 2);
		const before = await scriptCalls(client());
		await Bun.sleep(1_500);
		expect((await scriptCalls(client())) - before).toBe(0);
		expect(await client().send('LLEN', [keys.wake])).toBe(0);
		expect((await q.counts()).waiting).toBe(2);
	});
});

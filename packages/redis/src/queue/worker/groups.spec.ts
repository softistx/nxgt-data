import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
	blocked,
	eventually,
	gate,
	scriptCalls,
	useClients,
	useRedis,
} from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
import type { Worker } from './types';

const servers = useRedis();
const clients = useClients(servers);
const client = () => servers.redis.client;
const schema = z.object({ n: z.number() });
const capped = defineQueue({
	name: 'capped',
	schema,
	groups: { concurrency: 2 },
});
const keys = queueKeys('capped');

const opened: Worker[] = [];
afterEach(async () => {
	for (const worker of opened.splice(0)) await worker.close();
});

describe('a grouped queue with workers', () => {
	test('a group never runs above its concurrency, across workers and clients', async () => {
		const q = bindQueue(client(), capped);
		await q.addMany([
			...Array.from({ length: 10 }, (_, n) => ({
				data: { n },
				options: { group: 'A' },
			})),
			...Array.from({ length: 6 }, (_, n) => ({
				data: { n: 100 + n },
				options: { group: 'B' },
			})),
		]);
		let running = 0;
		let max = 0;
		let b = 0;
		let overlap = false;
		for (const own of clients()) {
			for (let i = 0; i < 2; i++) {
				opened.push(
					bindQueue(own, capped).work(async (job) => {
						if (job.data.n < 100) {
							running++;
							max = Math.max(max, running);
							if (b > 0) overlap = true;
							await Bun.sleep(40);
							running--;
						} else {
							b++;
							await Bun.sleep(40);
							b--;
						}
					}),
				);
			}
		}
		await eventually(async () => (await q.counts()).completed, 16);
		expect(max).toBeLessThanOrEqual(2);
		expect(max).toBe(2);
		expect(overlap).toBe(true);
	});

	test('workers do not spin while every ready job sits in a full group', async () => {
		const q = bindQueue(client(), capped);
		const hold = gate();
		await q.addMany(
			Array.from({ length: 5 }, (_, n) => ({
				data: { n },
				options: { group: 'A' },
			})),
		);
		await claim(client(), keys, 0, 30_000, undefined, { concurrency: 2 });
		for (let i = 0; i < 3; i++) opened.push(q.work(() => hold.opened));
		await eventually(async () => (await q.counts()).active, 2);
		await blocked(client(), 1);
		const before = await scriptCalls(client());
		await Bun.sleep(1_000);
		expect((await scriptCalls(client())) - before).toBeLessThanOrEqual(0);
		expect(await client().send('LLEN', [keys.wake])).toBe(0);
		hold.open();
		await eventually(async () => (await q.counts()).completed, 5);
	});

	test('a freed slot wakes a waiting worker at once', async () => {
		const q = bindQueue(client(), capped);
		const first = gate();
		const second = gate();
		const started: number[] = [];
		await q.addMany(
			Array.from({ length: 3 }, (_, n) => ({
				data: { n },
				options: { group: 'A' },
			})),
		);
		const gates = [first, second];
		for (let i = 0; i < 3; i++) {
			opened.push(
				q.work(async (job) => {
					started.push(job.data.n);
					await gates[job.data.n]?.opened;
				}),
			);
		}
		await eventually(async () => (await q.counts()).active, 2);
		await blocked(client(), 1);
		const at = Date.now();
		first.open();
		await eventually(() => started.length, 3);
		expect(Date.now() - at).toBeLessThan(500);
		second.open();
		await eventually(async () => (await q.counts()).completed, 3);
	});
});

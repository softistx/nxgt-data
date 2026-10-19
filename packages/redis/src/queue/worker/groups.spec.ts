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
import { bindQueue } from '../binding/bind-queue';
import { defineQueue } from '../definition/define-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim/claim';
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
		// A's jobs are held at a gate, so the cap is measured on state rather
		// than on how 40 ms sleeps happened to overlap on a loaded machine.
		const hold = gate();
		let running = 0;
		let max = 0;
		for (const own of clients()) {
			for (let i = 0; i < 2; i++) {
				opened.push(
					bindQueue(own, capped).work(async (job) => {
						if (job.data.n >= 100) return;
						running++;
						max = Math.max(max, running);
						await hold.opened;
						running--;
					}),
				);
			}
		}
		// Every B job finishes while A holds its two slots: B is never queued
		// behind the full group.
		await eventually(async () => (await q.counts()).completed, 6);
		await eventually(() => running, 2);
		await Bun.sleep(200);
		expect(running).toBe(2);
		hold.open();
		await eventually(async () => (await q.counts()).completed, 16);
		expect(max).toBe(2);
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
		const hold = gate();
		const started: string[] = [];
		await q.addMany(
			Array.from({ length: 3 }, (_, n) => ({
				data: { n },
				options: { group: 'A' },
			})),
		);
		for (let i = 0; i < 3; i++) {
			opened.push(
				q.work(async (job) => {
					started.push(job.id);
					await hold.opened;
				}),
			);
		}
		await eventually(async () => (await q.counts()).active, 2);
		await blocked(client(), 1);
		const [first] = started;
		if (!first) throw new Error('nothing started');
		const at = Date.now();
		expect(await q.cancel(first)).toBe(true);
		await eventually(() => started.length, 3);
		expect(Date.now() - at).toBeLessThan(500);
		hold.open();
		await eventually(async () => (await q.counts()).completed, 2);
	});

	test('idle() does not wait while the ready jobs sit in a full group', async () => {
		const one = defineQueue({
			name: 'one',
			schema,
			groups: { concurrency: 1 },
		});
		const q = bindQueue(client(), one);
		const hold = gate();
		await q.addMany([
			{ data: { n: 1 }, options: { group: 'A' } },
			{ data: { n: 2 }, options: { group: 'A' } },
		]);
		opened.push(q.work(() => hold.opened));
		await eventually(async () => (await q.counts()).active, 1);
		const second = q.work(() => undefined);
		opened.push(second);
		await blocked(client(), 1);
		const at = Date.now();
		await second.idle();
		expect(Date.now() - at).toBeLessThan(500);
		hold.open();
		await eventually(async () => (await q.counts()).completed, 2);
	});
});

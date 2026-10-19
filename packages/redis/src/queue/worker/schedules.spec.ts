import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import { eventually, useRedis } from '../../../test/fixtures';
import { def, type Fields, scheduleCalls } from '../../../test/schedule-calls';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { queueKeys } from '../keys';
import { CLAIM } from '../scripts/claim';
import { FIRE, SYNC } from '../scripts/schedule';
import type { Worker } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const calls = scheduleCalls(client);
const send = calls.send;
const schema = z.object({ to: z.string() });
const mails = defineQueue({
	name: 'mails',
	schema,
	lease: 5_000,
	backoff: { base: 10, max: 50 },
});

// A worker's SYNC runs once per client and queue name, so each test opens
// clients of its own, and the file closes them.
const workers: Worker[] = [];
const clients: RedisClient[] = [];
afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.close();
	for (const c of clients.splice(0)) c.close();
});
async function fresh(): Promise<RedisClient> {
	const c = new RedisClient(servers.redis.uri);
	await c.connect();
	clients.push(c);
	return c;
}
async function work(
	handler: (job: { id: string }) => unknown,
	definition = mails,
	on?: RedisClient,
) {
	const c = on ?? (await fresh());
	const worker = bindQueue(c, definition).work(handler);
	workers.push(worker);
	return { worker, client: c };
}
const jobKeys = async () =>
	((await send('KEYS', `${keys.prefix}*`)) as string[]).sort();
const state = (id: string) => client().hget(keys.job(id), 'state');
const due = (ms: number) => keys.job(`schedule:s:${ms}`);

describe('firing', () => {
	test('an every schedule fires about every second, on its grid', async () => {
		await calls.upsert('tick', Date.now() + 200, 'every', '1000');
		const seen: string[] = [];
		await work((job) => {
			seen.push(job.id);
		});
		await eventually(() => seen.length >= 3, true);
		const ms = seen.map((id) => {
			expect(id).toMatch(/^schedule:tick:\d+$/);
			return Number(id.split(':')[2]);
		});
		for (let i = 1; i < ms.length; i += 1) {
			expect((ms[i] as number) - (ms[i - 1] as number)).toBe(1000);
		}
	});

	test('two workers on two clients fire one due schedule once', async () => {
		const at = Date.now() - 100;
		await calls.upsert('s', at, 'every', '60000');
		const seen: string[] = [];
		const handler = (job: { id: string }) => {
			seen.push(job.id);
		};
		await work(handler);
		await work(handler);
		await eventually(() => seen.length, 1);
		await eventually(async () => await state(`schedule:s:${at}`), 'completed');
		expect(await jobKeys()).toEqual([due(at)]);
		expect(Number(await calls.score('s'))).toBe(at + 60_000);
	});

	test('an outage fires one occurrence, and the next is the first future tick', async () => {
		const at = Date.now() - 3 * 60_000 - 5;
		await calls.upsert('s', at, 'every', '60000');
		const seen: string[] = [];
		await work((job) => {
			seen.push(job.id);
		});
		await eventually(() => seen, [`schedule:s:${at}`]);
		const next = Number(await calls.score('s'));
		expect(next).toBe(at + 4 * 60_000);
		expect(next).toBeGreaterThan(Date.now());
		expect((await jobKeys()).length).toBe(1);
	});

	test('a cron fires once for an outage, then moves to its first future tick', async () => {
		const at = Date.now() - 3 * 60_000 - 5;
		await calls.upsert('s', at, 'cron', '* * * * *');
		await work(() => undefined);
		await eventually(async () => await state(`schedule:s:${at}`), 'completed');
		const next = Number(await calls.score('s'));
		expect(next).toBeGreaterThan(Date.now());
		expect(next % 60_000).toBe(0);
		expect(next - Date.now()).toBeLessThanOrEqual(60_000);
	});

	test('a changed schema fails the occurrence as INVALID, and the next one still fires', async () => {
		await calls.upsert('s', Date.now() - 10, 'every', '1000');
		await send('HSET', `${keys.schedule}s`, 'data', '{"to":1}');
		const { worker } = await work(() => undefined);
		const failed: { id: string; message: string }[] = [];
		worker.on('failed', (e) => {
			failed.push({ id: e.id, message: e.error.message });
		});
		await eventually(() => failed.length >= 2, true);
		for (const f of failed) {
			expect(f.id).toMatch(/^schedule:s:\d+$/);
			expect(f.message).toStartWith('INVALID');
		}
		expect(new Set(failed.map((f) => f.id)).size).toBe(failed.length);
	});

	test('a paused queue still fires; the job waits in ready until resume', async () => {
		const at = Date.now() - 10;
		await calls.upsert('s', at, 'every', '60000');
		const c = await fresh();
		const queue = bindQueue(c, mails);
		await queue.pause();
		const seen: string[] = [];
		await work(
			(job) => {
				seen.push(job.id);
			},
			mails,
			c,
		);
		await eventually(() => send('ZCARD', keys.ready), 1);
		expect(await state(`schedule:s:${at}`)).toBe('waiting');
		expect(seen).toEqual([]);
		await queue.resume();
		await eventually(() => seen, [`schedule:s:${at}`]);
	});
});

describe('round trips', () => {
	test('one FIRE per occurrence, one SYNC, and no extra CLAIM', async () => {
		const at = Date.now() - 10;
		await calls.upsert('s', at, 'every', '60000');
		const c = await fresh();
		const spy = spyOn(c, 'evalsha');
		const { worker } = await work(() => undefined, mails, c);
		await eventually(async () => await state(`schedule:s:${at}`), 'completed');
		await worker.idle();
		const claimsNow = () =>
			spy.mock.calls.filter((call) => call[0] === CLAIM.sha).length;
		const settled = claimsNow();
		await Bun.sleep(300);
		expect(claimsNow()).toBe(settled);
		const by = (script: { sha: string }) =>
			spy.mock.calls.filter((call) => call[0] === script.sha).length;
		expect(by(FIRE)).toBe(1);
		expect(by(SYNC)).toBe(1);
		// The first claim finds the due schedule; the wake FIRE leaves finds the
		// job; the slot's settle claims the next, and one more finds nothing.
		expect(by(CLAIM)).toBeLessThanOrEqual(3);
	});

	test('twenty due schedules that do not parse are deferred, never spun on, and a sound one behind them fires', async () => {
		const now = Date.now();
		for (let i = 0; i < 20; i += 1) {
			await calls.upsert(`bad${i}`, now - 1000 + i, 'cron', 'nope');
		}
		await calls.upsert('good', now - 500, 'every', '60000');
		const c = await fresh();
		const spy = spyOn(c, 'evalsha');
		const { worker } = await work(() => undefined, mails, c);
		const errors: unknown[] = [];
		worker.on('error', (e) => {
			errors.push(e);
		});
		await eventually(
			async () => await state(`schedule:good:${now - 500}`),
			'completed',
		);
		await worker.idle();
		const claimsNow = () =>
			spy.mock.calls.filter((call) => call[0] === CLAIM.sha).length;
		const settled = claimsNow();
		await Bun.sleep(300);
		expect(claimsNow()).toBe(settled);
		expect(errors.length).toBe(20);
		for (let i = 0; i < 20; i += 1) {
			const score = Number(await calls.score(`bad${i}`));
			expect(score).toBeGreaterThan(now + 3_599_000);
			expect(score).toBeLessThanOrEqual(Date.now() + 3_600_000);
		}
		expect(await jobKeys()).toEqual([keys.job(`schedule:good:${now - 500}`)]);
		const claims = spy.mock.calls.filter((call) => call[0] === CLAIM.sha);
		expect(claims.length).toBeLessThanOrEqual(5);
	});
});

describe('a slot that fires', () => {
	test("idle does not resolve while the slot's own occurrence waits in ready", async () => {
		const at = Date.now() + 300;
		await calls.upsert('s', at, 'every', '60000');
		const seen: string[] = [];
		await work(async (job) => {
			seen.push(job.id);
			if (job.id === 'a') await Bun.sleep(500);
		}).then(async ({ worker, client: c }) => {
			await bindQueue(c, mails).add({ to: 'x' }, { id: 'a' });
			await eventually(() => seen, ['a']);
			await worker.idle();
			// The settle of `a` saw the schedule due and fired it: idle waited
			// for that occurrence to run.
			expect(seen).toEqual(['a', `schedule:s:${at}`]);
		});
	});
});

describe('SYNC at start', () => {
	const withStatic = defineQueue({
		name: 'mails',
		schema,
		schedules: { weekly: { cron: '0 7 * * 1', data: { to: 'a' } } },
	});

	test('adds a static schedule as the definition, removes a stale one, spares a runtime one', async () => {
		await calls.sync([def('old', Date.now() + 1000)]);
		await calls.upsert('mine', Date.now() + 60_000, 'every', '60000');
		const { client: c } = await work(() => undefined, withStatic);
		const views = () =>
			bindQueue(c, withStatic)
				.schedules.list()
				.then(
					(list) =>
						list.map((v) => [v.id, v.origin]).sort() as [string, string][],
				);
		await eventually(views, [
			['mine', 'runtime'],
			['weekly', 'definition'],
		]);
		expect(await calls.hash('old')).toEqual({} as Fields);
	});

	test('runs once per client and queue: a second worker adds no SYNC', async () => {
		const c = await fresh();
		const spy = spyOn(c, 'evalsha');
		const first = await work(() => undefined, withStatic, c);
		await eventually(
			() =>
				bindQueue(c, withStatic)
					.schedules.list()
					.then((l) => l.length),
			1,
		);
		await work(() => undefined, withStatic, c);
		await first.worker.idle();
		const syncs = () =>
			spy.mock.calls.filter((call) => call[0] === SYNC.sha).length;
		expect(syncs()).toBe(1);
	});

	test('finishes before the first claim', async () => {
		const c = await fresh();
		const spy = spyOn(c, 'evalsha');
		await work(() => undefined, withStatic, c);
		await eventually(
			() => spy.mock.calls.some((call) => call[0] === CLAIM.sha),
			true,
		);
		const first = spy.mock.calls.findIndex((call) => call[0] === CLAIM.sha);
		const sync = spy.mock.calls.findIndex((call) => call[0] === SYNC.sha);
		expect(sync).toBeGreaterThanOrEqual(0);
		expect(sync).toBeLessThan(first);
	});
});

describe('a SYNC that fails', () => {
	test('stalls no job, is retried, and succeeds later', async () => {
		const withStatic = defineQueue({
			name: 'mails',
			schema,
			schedules: { weekly: { cron: '0 7 * * 1', data: { to: 'a' } } },
		});
		const ids = Array.from({ length: 2001 }, (_, n) => `stale${n}`);
		await send('SADD', keys.schedulesDefinition, ...ids);
		const c = await fresh();
		const seen: string[] = [];
		const { worker } = await work(
			(job) => {
				seen.push(job.id);
			},
			withStatic,
			c,
		);
		const errors: unknown[] = [];
		worker.on('error', (e) => {
			errors.push(e);
		});
		await bindQueue(c, withStatic).add({ to: 'x' }, { id: 'j' });
		await eventually(() => seen, ['j']);
		expect(await calls.hash('weekly')).toEqual({} as Fields);
		await eventually(() => errors.length >= 1, true);
		await send('DEL', keys.schedulesDefinition);
		await eventually(
			async () => (await calls.hash('weekly')).origin,
			'definition',
		);
	});
});

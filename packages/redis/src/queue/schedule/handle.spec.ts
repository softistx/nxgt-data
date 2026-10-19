import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { scriptCalls, useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { def, scheduleCalls } from '../../../test/schedule-calls';
import * as queues from '../../../test/wiring/queues';
import type { QueueError } from '../../errors/queue-error';
import { defineRedis } from '../../wiring/config/define-redis';
import { openRedis } from '../../wiring/open-redis';
import { bindQueue } from '../binding/bind-queue';
import { defineQueue } from '../definition/define-queue';

const servers = useRedis();
const client = () => servers.redis.client;
const calls = scheduleCalls(client);
const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string(), template: z.string().default('hi') }),
});
const q = () => bindQueue(client(), mails);
const data = { to: 'a@b.c' };

describe('schedules.upsert and list', () => {
	test('a cron schedule is listed as runtime, with its next as a Date', async () => {
		const before = Date.now();
		await q().schedules.upsert('daily', {
			cron: '0 7 * * *',
			timezone: 'Europe/Paris',
			data,
		});
		const [view, ...rest] = await q().schedules.list();
		expect(rest).toEqual([]);
		expect(view).toMatchObject({
			id: 'daily',
			cron: '0 7 * * *',
			timezone: 'Europe/Paris',
			data: { to: 'a@b.c', template: 'hi' },
			origin: 'runtime',
		});
		expect(view?.every).toBeUndefined();
		expect(view?.next).toBeInstanceOf(Date);
		expect(view?.next.getTime()).toBeGreaterThan(before);
		expect(view?.next.getTime()).toBeLessThanOrEqual(
			before + 86_400_000 + 1000,
		);
	});

	test('an every schedule is listed with its interval in ms and next = now + every', async () => {
		const before = Date.now();
		await q().schedules.upsert('beat', { every: '30s', data });
		const [view] = await q().schedules.list();
		expect(view).toMatchObject({
			id: 'beat',
			every: 30_000,
			origin: 'runtime',
		});
		expect(view?.cron).toBeUndefined();
		expect(view?.timezone).toBeUndefined();
		const next = view?.next.getTime() ?? 0;
		expect(next).toBeGreaterThanOrEqual(before + 30_000);
		expect(next).toBeLessThanOrEqual(Date.now() + 30_000);
	});

	test('an upsert of the same id replaces it and recomputes next', async () => {
		await q().schedules.upsert('s', { every: '1h', data });
		const first = (await q().schedules.list())[0]?.next.getTime() ?? 0;
		await q().schedules.upsert('s', { cron: '*/5 * * * *', data });
		const list = await q().schedules.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.cron).toBe('*/5 * * * *');
		expect(list[0]?.every).toBeUndefined();
		expect(list[0]?.next.getTime()).toBeLessThan(first);
	});

	test('list pages by next, soonest first', async () => {
		await q().schedules.upsert('slow', { every: '2h', data });
		await q().schedules.upsert('fast', { every: '1m', data });
		await q().schedules.upsert('mid', { every: '1h', data });
		const ids = (page?: { offset?: number; limit?: number }) =>
			q()
				.schedules.list(page)
				.then((views) => views.map((v) => v.id));
		expect(await ids()).toEqual(['fast', 'mid', 'slow']);
		expect(await ids({ offset: 1, limit: 1 })).toEqual(['mid']);
		expect(await ids({ offset: 3 })).toEqual([]);
	});

	test('list refuses an offset or limit out of range, naming the call', async () => {
		for (const page of [
			{ offset: -1 },
			{ offset: 1.5 },
			{ limit: 0 },
			{ limit: 1001 },
		]) {
			const refused = (await rejection(q().schedules.list(page))) as Error;
			expect(refused).toBeInstanceOf(TypeError);
		}
		expect(
			((await rejection(q().schedules.list({ limit: 0 }))) as Error).message,
		).toBe('schedules.list on "mails": limit is a whole number from 1 to 1000');
		expect(
			((await rejection(q().schedules.list({ offset: -1 }))) as Error).message,
		).toBe('schedules.list on "mails": offset is a whole number from 0');
	});

	test('a definition-owned id is a TypeError after the round trip, and left as it was', async () => {
		await calls.sync([def('static', Date.now() + 60_000)]);
		const refused = (await rejection(
			q().schedules.upsert('static', { every: '1m', data }),
		)) as Error;
		expect(refused).toBeInstanceOf(TypeError);
		expect(refused.message).toBe(
			'schedules.upsert on "mails": "static" belongs to the definition; change it in defineQueue',
		);
		expect((await calls.hash('static')).origin).toBe('definition');
		expect((await q().schedules.list())[0]?.origin).toBe('definition');
	});

	test('validates before any round trip', async () => {
		await q().schedules.list();
		const before = await scriptCalls(client());
		const bad = [
			{ cron: '* * * * *', every: '1m', data },
			{ data },
			{ every: '1m', timezone: 'UTC', data },
			{ cron: '* * * * *', timezone: 'Mars/Base', data },
			{ every: '500ms', data },
			{ cron: 'nope', data },
		];
		for (const schedule of bad) {
			const refused = await rejection(
				q().schedules.upsert('x', schedule as never),
			);
			expect(refused).toBeInstanceOf(TypeError);
			expect((refused as Error).message).toStartWith(
				'schedules.upsert on "mails": schedule "x"',
			);
		}
		const id = (await rejection(
			q().schedules.upsert('a:b', { every: '1m', data }),
		)) as Error;
		expect(id.message).toBe(
			'schedules.upsert on "mails": a schedule id is a string of 1 to 256 characters without braces or colons',
		);
		const invalid = (await rejection(
			q().schedules.upsert('x', { every: '1m', data: { to: 1 } as never }),
		)) as QueueError;
		expect(invalid.code).toBe('INVALID');
		expect(invalid.queue).toBe('mails');
		expect(invalid.message).toStartWith(
			'schedules.upsert on "mails": schedule "x" data does not match the schema',
		);
		const removal = (await rejection(q().schedules.remove('a:b'))) as Error;
		expect(removal).toBeInstanceOf(TypeError);
		expect(removal.message).toBe(
			'schedules.remove on "mails": a schedule id is a string of 1 to 256 characters without braces or colons',
		);
		expect(await scriptCalls(client())).toBe(before);
	});

	test('list gives data undefined for a stored data that no longer parses', async () => {
		await q().schedules.upsert('s', { every: '1m', data });
		await client().hset('queue:{mails}:schedule:s', { data: '{"to":1}' });
		const [view] = await q().schedules.list();
		expect(view?.id).toBe('s');
		expect(view?.data).toBeUndefined();
	});
});

describe('schedules.remove', () => {
	test('removes a runtime schedule', async () => {
		await q().schedules.upsert('s', { every: '1m', data });
		await q().schedules.remove('s');
		expect(await q().schedules.list()).toEqual([]);
	});

	test('NOT_FOUND for none, as remove does', async () => {
		const refused = (await rejection(
			q().schedules.remove('none'),
		)) as QueueError;
		expect(refused.code).toBe('NOT_FOUND');
		expect(refused.queue).toBe('mails');
		expect(refused.job).toBeUndefined();
		expect(refused.message).toBe(
			'schedules.remove on "mails": no schedule "none"',
		);
	});

	test('a definition-owned id is a TypeError', async () => {
		await calls.sync([def('static', Date.now() + 60_000)]);
		const refused = (await rejection(q().schedules.remove('static'))) as Error;
		expect(refused).toBeInstanceOf(TypeError);
		expect(refused.message).toBe(
			'schedules.remove on "mails": "static" belongs to the definition; change it in defineQueue',
		);
		expect(await client().zcard('queue:{mails}:schedules')).toBe(1);
	});
});

describe('after redis.close()', () => {
	test('upsert, list and remove pass through', async () => {
		const redis = servers.track(
			await openRedis(defineRedis({ client: client(), queues })),
		);
		await redis.close();
		const schedules = redis.queues.mails.schedules;
		await schedules.upsert('s', { every: '1m', data: { to: 'a@b.c' } });
		expect((await schedules.list()).map((v) => v.id)).toEqual(['s']);
		await schedules.remove('s');
		expect(await schedules.list()).toEqual([]);
	});
});

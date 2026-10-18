import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { mailQueue, scriptCalls, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { QueueError } from '../errors/queue-error';
import { bindQueue } from './bind-queue';
import { defineQueue } from './define-queue';
import { queueKeys } from './keys';

const servers = useRedis();
const mails = () => bindQueue(servers.redis.client, mailQueue);
const keys = queueKeys('mails');
const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const to = (address: string) => ({ to: address });

const send = (...args: string[]) =>
	servers.redis.client.send(args[0] ?? '', args.slice(1));

describe('add', () => {
	test('add stores the parsed output and returns a generated id', async () => {
		const handle = await mails().add(to('a@b.c'));
		expect(handle.id).toMatch(UUID_V7);
		expect(handle.deduplicated).toBe(false);
		const client = servers.redis.client;
		expect(
			JSON.parse((await client.hget(keys.job(handle.id), 'data')) ?? ''),
		).toEqual({
			to: 'a@b.c',
			template: 'welcome',
		});
		expect(await client.hget(keys.job(handle.id), 'state')).toBe('waiting');
		expect(await client.hget(keys.job(handle.id), 'attempt')).toBe('0');
		expect(await client.hget(keys.job(handle.id), 'attempts')).toBe('3');
		expect(Number(await send('ZSCORE', keys.ready, handle.id))).toBe(
			0 * 2 ** 40 + 1,
		);
		expect(await send('LLEN', keys.wake)).toBe(1);
	});

	test('wake holds one token however many jobs arrive', async () => {
		await mails().add(to('a'));
		await mails().add(to('b'));
		expect(await send('LLEN', keys.wake)).toBe(1);
	});

	test('a delayed job pushes a token only when it becomes the head of delayed', async () => {
		await mails().add(to('late'), { delay: '1h' });
		expect(await send('LLEN', keys.wake)).toBe(1);
		await send('DEL', keys.wake);
		await mails().add(to('later'), { delay: '2h' });
		expect(await send('LLEN', keys.wake)).toBe(0);
		await mails().add(to('sooner'), { delay: '30m' });
		expect(await send('LLEN', keys.wake)).toBe(1);
	});

	test('the ready score of a priority stays an exact integer', async () => {
		const { id } = await mails().add(to('a'), { priority: 1000 });
		expect(Number(await send('ZSCORE', keys.ready, id))).toBe(
			1000 * 2 ** 40 + 1,
		);
	});

	test('an id already there is not added again', async () => {
		const first = await mails().add(to('first'), { id: 'j1' });
		const second = await mails().add(to('second'), { id: 'j1' });
		expect(first).toEqual({ id: 'j1', deduplicated: false });
		expect(second).toEqual({ id: 'j1', deduplicated: true });
		const data = await servers.redis.client.hget(keys.job('j1'), 'data');
		expect(JSON.parse(data ?? '').to).toBe('first');
		expect(await send('ZCARD', keys.ready)).toBe(1);
	});

	test('delay and at put the job in delayed, scored by the server clock', async () => {
		const [seconds, micros] = (await send('TIME')) as [string, string];
		const now = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
		const { id } = await mails().add(to('a'), { delay: '1m' });
		const score = Number(await send('ZSCORE', keys.delayed, id));
		expect(score).toBeGreaterThanOrEqual(now + 59_000);
		expect(score).toBeLessThanOrEqual(now + 61_000);
		expect(await servers.redis.client.hget(keys.job(id), 'state')).toBe(
			'delayed',
		);

		const past = await mails().add(to('b'), {
			at: new Date(Date.now() - 1000),
		});
		expect(await send('ZSCORE', keys.ready, past.id)).not.toBeNull();
		const future = await mails().add(to('c'), {
			at: new Date(Date.now() + 90_000),
		});
		expect(await send('ZSCORE', keys.delayed, future.id)).not.toBeNull();
	});

	test('priority orders ready, FIFO within a priority', async () => {
		await mails().add(to('a'), { id: 'p5a', priority: 5 });
		await mails().add(to('b'), { id: 'p0', priority: 0 });
		await mails().add(to('c'), { id: 'p5b', priority: 5 });
		expect(await send('ZRANGE', keys.ready, '0', '-1')).toEqual([
			'p0',
			'p5a',
			'p5b',
		]);
	});

	test('refuses with INVALID, naming the queue, never the data', async () => {
		const secret = 'secret-address';
		const error = await rejection(mails().add({ to: 5, secret } as never));
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).queue).toBe('mails');
		expect((error as QueueError).message).toContain('"mails"');
		expect((error as QueueError).message).not.toContain('5');
		expect((error as QueueError).message).not.toContain(secret);
		expect(await send('DBSIZE')).toBe(0);
	});

	test('malformed options are a TypeError naming the call, the queue and the option, never the value, and write nothing', async () => {
		const id =
			'id is a string of 1 to 256 characters without braces, which are a hash tag';
		const priority = 'priority is a whole number from 0 to 1000';
		const delay =
			"delay is a whole number of milliseconds or a string such as '10m'";
		const bad: [string, Record<string, unknown>][] = [
			['at is a valid Date', { at: new Date('nope') }],
			[priority, { priority: 1001 }],
			[priority, { priority: -1 }],
			[priority, { priority: 1.5 }],
			[id, { id: 'a}b' }],
			[id, { id: 'a{b' }],
			[id, { id: '' }],
			[id, { id: 'x'.repeat(257) }],
			[
				'delay and at say the same thing; give one',
				{ delay: '1m', at: new Date() },
			],
			[delay, { delay: 'soon' }],
			[delay, { delay: -5 }],
		];
		for (const [message, options] of bad) {
			const error = await rejection(mails().add(to('a'), options as never));
			expect(error).toBeInstanceOf(TypeError);
			expect(error).not.toBeInstanceOf(QueueError);
			expect((error as Error).message).toBe(`add on "mails": ${message}`);
		}
		const many = await rejection(
			mails().addMany([{ data: to('a'), options: { priority: 1001 } }]),
		);
		expect((many as Error).message).toBe(`addMany on "mails": ${priority}`);
		expect(await send('DBSIZE')).toBe(0);
	});

	test('a payload that is not JSON-safe is refused', async () => {
		const dates = defineQueue({
			name: 'dates',
			schema: z.object({ at: z.date() }),
		});
		const error = await rejection(
			bindQueue(servers.redis.client, dates).add({ at: new Date() }),
		);
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).message).toBe(
			'add on "dates": the data does not match the schema once stored as JSON (invalid_type)',
		);
		expect(await send('DBSIZE')).toBe(0);
	});

	test('an INVALID carries the issue codes, and nothing of the payload, however it is printed', async () => {
		const strict = defineQueue({
			name: 'strict',
			schema: z.strictObject({ to: z.string() }),
		});
		const open = defineQueue({
			name: 'open',
			schema: z.record(z.string().regex(/^[a-z]+$/), z.string()),
		});
		const stray = await rejection(
			bindQueue(servers.redis.client, strict).add({
				to: 'a',
				'stray-key-4f9': 1,
			} as never),
		);
		expect((stray as QueueError).message).toBe(
			'add on "strict": the data does not match the schema (unrecognized_keys)',
		);
		const record = await rejection(
			bindQueue(servers.redis.client, open).add({ 'Record-Key-7c2': 'x' }),
		);
		expect((record as QueueError).message).toBe(
			'add on "open": the data does not match the schema (invalid_key)',
		);
		expect((record as QueueError).cause).toBeUndefined();
		// Bun.inspect prints the cause and every own property.
		expect(Bun.inspect(stray)).not.toContain('stray-key-4f9');
		expect(Bun.inspect(record)).not.toContain('Record-Key-7c2');
	});

	test('add spends one script', async () => {
		const before = await scriptCalls(servers.redis.client);
		await mails().add(to('a'));
		expect(await scriptCalls(servers.redis.client)).toBe(before + 1);
	});
});

describe('addMany', () => {
	test('keeps order, dedupes within the batch, and spends one script per 500', async () => {
		const items = Array.from({ length: 1200 }, (_, i) => ({
			data: to(`u${i}`),
			options: { id: `j${i}` },
		}));
		items.push({ data: to('again'), options: { id: 'j3' } });
		const before = await scriptCalls(servers.redis.client);
		const handles = await mails().addMany(items);
		expect(await scriptCalls(servers.redis.client)).toBe(before + 3);
		expect(handles).toHaveLength(1201);
		expect(handles.map((h) => h.id)).toEqual(items.map((i) => i.options.id));
		expect(handles.filter((h) => h.deduplicated).map((h) => h.id)).toEqual([
			'j3',
		]);
		expect(handles[1200]?.deduplicated).toBe(true);
		expect(await send('ZCARD', keys.ready)).toBe(1200);
		expect(await send('LLEN', keys.wake)).toBe(1);
	});

	test('one bad item refuses the whole call and writes nothing', async () => {
		const error = await rejection(
			mails().addMany([{ data: to('a') }, { data: { to: 5 } as never }]),
		);
		expect((error as QueueError).code).toBe('INVALID');
		expect(await send('DBSIZE')).toBe(0);
	});

	test('an empty batch runs nothing', async () => {
		const before = await scriptCalls(servers.redis.client);
		expect(await mails().addMany([])).toEqual([]);
		expect(await scriptCalls(servers.redis.client)).toBe(before);
	});
});

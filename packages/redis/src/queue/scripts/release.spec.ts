import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import { expectGroupState, scan } from '../../../test/group-state';
import { rejection } from '../../../test/rejection';
import type { QueueError } from '../../errors/queue-error';
import { bindQueue } from '../binding/bind-queue';
import { defineQueue } from '../definition/define-queue';
import { queueKeys } from '../keys';
import { claim } from './claim/claim';
import { release } from './release';
import { complete } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const send = (...args: string[]) => client().send(args[0] ?? '', args.slice(1));
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

/** Everything the queue holds, in a form that compares. */
async function snapshot(): Promise<string> {
	const out: Record<string, unknown> = {};
	for (const key of (await scan(client(), 'queue:*')).sort()) {
		const type = await send('TYPE', key);
		if (type === 'hash') out[key] = await send('HGETALL', key);
		else if (type === 'zset')
			out[key] = await send('ZRANGE', key, '0', '-1', 'WITHSCORES');
		else if (type === 'list') out[key] = await send('LRANGE', key, '0', '-1');
		else if (type === 'set') out[key] = await send('SMEMBERS', key);
		else out[key] = await client().get(key);
	}
	return JSON.stringify(out);
}

/** Adds job `a` and claims it; answers its token. */
async function claimed(): Promise<string> {
	await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
	const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
	if (!job) throw new Error('not claimed');
	await send('DEL', keys.wake);
	return job.token;
}

describe('RELEASE', () => {
	test('gives a job back as the claim found it, with a wake token', async () => {
		const token = await claimed();
		expect(
			await release(client(), keys, mailQueue, [{ id: 'a', token }]),
		).toEqual(['a']);
		expect(await hget('a', 'state')).toBe('waiting');
		expect(await hget('a', 'attempt')).toBe('0');
		expect(await hget('a', 'token')).toBeNull();
		expect(await send('ZCARD', keys.active)).toBe(0);
		expect(await send('ZRANGE', keys.ready, '0', '-1')).toEqual(['a']);
		expect(await send('LLEN', keys.wake)).toBe(1);
		const [again] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
		expect(again?.attempt).toBe(1);
	});

	test('leaves no wake token on a paused queue', async () => {
		const token = await claimed();
		await bindQueue(client(), mailQueue).pause();
		await release(client(), keys, mailQueue, [{ id: 'a', token }]);
		expect(await hget('a', 'state')).toBe('waiting');
		expect(await send('LLEN', keys.wake)).toBe(0);
	});

	test('writes nothing for a token that does not hold', async () => {
		await claimed();
		const before = await snapshot();
		const token = 'f'.repeat(32);
		expect(
			await release(client(), keys, mailQueue, [{ id: 'a', token }]),
		).toEqual([]);
		expect(await snapshot()).toBe(before);
	});

	test('writes nothing for a job no longer active', async () => {
		const token = await claimed();
		await complete(client(), keys, mailQueue, 'a', token, undefined, false);
		const before = await snapshot();
		expect(
			await release(client(), keys, mailQueue, [{ id: 'a', token }]),
		).toEqual([]);
		expect(await snapshot()).toBe(before);
	});

	test.each([
		['attempts', 'inf'],
		['attempt', '0'],
		['group', 'a:b'],
		['state', 'waiting'],
	])('skips a hash whose %s is %s, untouched', async (field, value) => {
		const token = await claimed();
		await send('HSET', keys.job('a'), field, value);
		const before = await snapshot();
		expect(
			await release(client(), keys, mailQueue, [{ id: 'a', token }]),
		).toEqual([]);
		expect(await snapshot()).toBe(before);
	});

	test('gives back the sound ones of a batch, and skips the rest', async () => {
		const queue = bindQueue(client(), mailQueue);
		await queue.add({ to: 'a' }, { id: 'a' });
		await queue.add({ to: 'b' }, { id: 'b' });
		const jobs = (await claim(client(), keys, 2, 30_000, undefined)).jobs;
		const [a, b] = jobs;
		if (!a || !b) throw new Error('not claimed');
		const reply = await release(client(), keys, mailQueue, [
			{ id: a.id, token: a.token },
			{ id: b.id, token: 'f'.repeat(32) },
		]);
		expect(reply).toEqual([a.id]);
		expect(await hget(b.id, 'state')).toBe('active');
	});

	test('sends nothing for no jobs', async () => {
		expect(await release(client(), keys, mailQueue, [])).toEqual([]);
		expect(await client().get(keys.groupsMode)).toBeNull();
	});

	test('a grouped release on an ungrouped queue is refused, nothing written', async () => {
		const token = await claimed();
		const before = await snapshot();
		const error = await rejection(
			release(client(), keys, { ...mailQueue, groups: { concurrency: 1 } }, [
				{ id: 'a', token },
			]),
		);
		expect((error as QueueError).code).toBe('GROUPS_MISMATCH');
		expect(await snapshot()).toBe(before);
	});
});

describe('RELEASE against a reclaim of the same job', () => {
	const grouped = defineQueue({
		name: 'mails',
		schema: mailQueue.schema,
		lease: 300,
		groups: { concurrency: 5 },
	});

	/**
	 * Claims `a` under a token, lapses its lease, and lets a claim reclaim it
	 * while a higher-priority `b` takes the only place: `a` is `waiting`, its
	 * token deleted. The clock is the lease score, set to 1, not a sleep.
	 */
	async function reclaimed(definition: typeof mailQueue | typeof grouped) {
		const queue = bindQueue(client(), definition);
		const group = definition.groups ? { group: 'A' } : {};
		await queue.add({ to: 'a' }, { id: 'a', ...group });
		const [first] = (
			await claim(client(), keys, 1, 30_000, undefined, definition.groups)
		).jobs;
		if (!first) throw new Error('not claimed');
		await send('ZADD', keys.active, '1', 'a');
		await queue.add(
			{ to: 'b' },
			{ id: 'b', priority: 0, ...(definition.groups ? { group: 'B' } : {}) },
		);
		const second = await claim(
			client(),
			keys,
			1,
			30_000,
			undefined,
			definition.groups,
		);
		expect(second.stalled).toEqual(['a']);
		expect(second.jobs.map((job) => job.id)).toEqual(['b']);
		await send('DEL', keys.wake);
		return first.token;
	}

	test.each([
		['ungrouped', mailQueue],
		['grouped', grouped],
	] as const)(
		'a RELEASE with the old token is refused by the state check (token deleted), %s, and the job runs once',
		async (_name, definition) => {
			const token = await reclaimed(definition);
			expect(await hget('a', 'state')).toBe('waiting');
			expect(await hget('a', 'token')).toBeNull();
			expect(await hget('a', 'attempt')).toBe('1');
			const before = await snapshot();
			expect(
				await release(client(), keys, definition, [{ id: 'a', token }]),
			).toEqual([]);
			// No attempt decrement, no second ready_add, no slot freed, no wake.
			expect(await snapshot()).toBe(before);
			expect(await hget('a', 'attempt')).toBe('1');
			expect(await send('LLEN', keys.wake)).toBe(0);
			if (definition.groups) await expectGroupState(client(), keys, 5);
			// The reclaimed job is in ready once, and one claim runs it, attempt 2.
			expect(await send('ZRANGE', keys.ready, '0', '-1')).toEqual(['a']);
			const next = await claim(
				client(),
				keys,
				5,
				30_000,
				undefined,
				definition.groups,
			);
			expect(next.jobs.map((job) => [job.id, job.attempt])).toEqual([['a', 2]]);
			expect(await send('ZCARD', keys.ready)).toBe(0);
			if (definition.groups) await expectGroupState(client(), keys, 5);
		},
	);

	test.each([
		['ungrouped', mailQueue],
		['grouped', grouped],
	] as const)(
		'a RELEASE with the old token is refused by the token fence once the reclaim is claimed again, %s',
		async (_name, definition) => {
			const token = await reclaimed(definition);
			const [again] = (
				await claim(client(), keys, 1, 30_000, undefined, definition.groups)
			).jobs;
			if (!again) throw new Error('not claimed again');
			expect(again.id).toBe('a');
			expect(again.token).not.toBe(token);
			const before = await snapshot();
			expect(
				await release(client(), keys, definition, [{ id: 'a', token }]),
			).toEqual([]);
			expect(await snapshot()).toBe(before);
			expect(await hget('a', 'token')).toBe(again.token);
			expect(await hget('a', 'attempt')).toBe('2');
			if (definition.groups) await expectGroupState(client(), keys, 5);
		},
	);
});

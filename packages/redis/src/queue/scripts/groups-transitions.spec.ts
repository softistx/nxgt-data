import { describe, expect, test } from 'bun:test';
import { mailQueue, useRedis } from '../../../test/fixtures';
import {
	addGrouped,
	expectGroupState,
	grouped,
	scan,
} from '../../../test/group-state';
import { rejection } from '../../../test/rejection';
import { scheduleCalls } from '../../../test/schedule-calls';
import { runScript } from '../../scripts/run-script';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { ADD } from './add';
import { claim, groupArgs } from './claim';
import { fail } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const zcard = async (key: string) =>
	Number(await client().send('ZCARD', [key]));
const llen = async (key: string) => Number(await client().send('LLEN', [key]));
const members = async (key: string) =>
	(await client().send('ZRANGE', [key, '0', '-1'])) as string[];
const take = async (n: number, cap: number) =>
	await claim(client(), keys, n, 30_000, undefined, { concurrency: cap });

describe('groups through cancel', () => {
	test('a waiting job leaves its group zset', async () => {
		const q = bindQueue(client(), grouped(0));
		await addGrouped(client(), keys, 0, [
			{ id: 'a1', group: 'A' },
			{ id: 'a2', group: 'A' },
		]);
		expect(await q.cancel('a1')).toBe(true);
		expect(await members(`${keys.group}A:ready`)).toEqual(['a2']);
		expect(await members(keys.ready)).toEqual(['a2']);
		await expectGroupState(client(), keys, 0);
	});

	test('an active job frees its slot, queues the group and wakes a worker', async () => {
		const q = bindQueue(client(), grouped(1));
		await addGrouped(client(), keys, 1, [
			{ id: 'a1', group: 'A' },
			{ id: 'a2', group: 'A' },
		]);
		await take(1, 1);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
		expect(await llen(keys.groupsReady)).toBe(0);
		await client().send('DEL', [keys.wake]);
		expect(await q.cancel('a1')).toBe(true);
		expect(await client().get(`${keys.group}A:active`)).toBeNull();
		expect(
			await client().send('LRANGE', [keys.groupsReady, '0', '-1']),
		).toEqual(['A']);
		expect(await llen(keys.wake)).toBe(1);
		await expectGroupState(client(), keys, 1);
	});
});

describe('groups through remove', () => {
	test('a waiting job leaves its group zset', async () => {
		const q = bindQueue(client(), grouped(0));
		await addGrouped(client(), keys, 0, [
			{ id: 'a1', group: 'A' },
			{ id: 'd1', group: '' },
		]);
		await q.remove('a1');
		await q.remove('d1');
		expect(await zcard(keys.ready)).toBe(0);
		expect(await zcard(`${keys.group}A:ready`)).toBe(0);
		expect(await zcard(`${keys.group}:ready`)).toBe(0);
		await expectGroupState(client(), keys, 0);
	});
});

describe('groups through retry', () => {
	test('a failed job rejoins its group zset and queues the group', async () => {
		const q = bindQueue(client(), grouped(1));
		await addGrouped(client(), keys, 1, [
			{ id: 'a1', group: 'A', attempts: 1 },
		]);
		const [job] = (await take(1, 1)).jobs;
		if (!job) throw new Error('a job expected');
		await fail(
			client(),
			keys,
			grouped(1),
			'a1',
			job.token,
			{ name: 'x', message: 'b' },
			null,
			false,
		);
		expect(await llen(keys.groupsReady)).toBe(0);
		await q.retry('a1');
		expect(await members(`${keys.group}A:ready`)).toEqual(['a1']);
		expect(
			await client().send('LRANGE', [keys.groupsReady, '0', '-1']),
		).toEqual(['A']);
		await expectGroupState(client(), keys, 1);
	});
});

describe('groups through the debounce', () => {
	const addDebounced = (id: string, group: string, key = 'k') =>
		runScript(
			client(),
			ADD,
			[
				keys.delayed,
				keys.ready,
				keys.seq,
				keys.wake,
				keys.paused,
				keys.groupsReady,
				keys.groupsQueued,
				keys.groupsMode,
			],
			[
				keys.prefix,
				keys.dedupe,
				...groupArgs(keys, { concurrency: 0 }),
				id,
				'{"to":"x"}',
				0,
				3,
				0,
				-1,
				-1,
				'd',
				key,
				60_000,
				group,
			],
		);

	test('a waiting grouped job moves to delayed and leaves its group zset', async () => {
		await addDebounced('a1', 'A');
		expect(await members(`${keys.group}A:ready`)).toEqual(['a1']);
		expect(await addDebounced('a2', 'A')).toEqual(['a1']);
		expect(await members(keys.delayed)).toEqual(['a1']);
		expect(await zcard(keys.ready)).toBe(0);
		expect(await zcard(`${keys.group}A:ready`)).toBe(0);
		await expectGroupState(client(), keys, 0);
	});
});

describe('a debounce hit that names another group', () => {
	test('keeps the first job and its group, and joins nobody else', async () => {
		const add = (id: string, group: string) =>
			runScript(
				client(),
				ADD,
				[
					keys.delayed,
					keys.ready,
					keys.seq,
					keys.wake,
					keys.paused,
					keys.groupsReady,
					keys.groupsQueued,
					keys.groupsMode,
				],
				[
					keys.prefix,
					keys.dedupe,
					...groupArgs(keys, { concurrency: 0 }),
					id,
					'{"to":"x"}',
					0,
					3,
					0,
					-1,
					-1,
					'd',
					'same',
					60_000,
					group,
				],
			);
		await add('a1', 'A');
		expect(await add('a2', 'B')).toEqual(['a1']);
		expect(await client().send('HGET', [`${keys.prefix}a1`, 'group'])).toBe(
			'A',
		);
		expect(await client().send('EXISTS', [`${keys.prefix}a2`])).toBe(0);
		await take(0, 0);
		expect(await members(`${keys.group}A:ready`)).toEqual(['a1']);
		expect(await members(`${keys.group}B:ready`)).toEqual([]);
		expect(await members(keys.ready)).toEqual(['a1']);
		await expectGroupState(client(), keys, 0);
	});
});

describe('RESUME on a grouped queue', () => {
	test('leaves no wake token when every ready job sits in a full group', async () => {
		const q = bindQueue(client(), grouped(1));
		await addGrouped(client(), keys, 1, [
			{ id: 'a1', group: 'A' },
			{ id: 'a2', group: 'A' },
		]);
		await take(1, 1);
		await q.pause();
		await client().send('DEL', [keys.wake]);
		await q.resume();
		expect(await llen(keys.wake)).toBe(0);
		await expectGroupState(client(), keys, 1);
	});

	test('leaves one when a group can run', async () => {
		const q = bindQueue(client(), grouped(1));
		await addGrouped(client(), keys, 1, [{ id: 'a1', group: 'A' }]);
		await q.pause();
		await client().send('DEL', [keys.wake]);
		await q.resume();
		expect(await llen(keys.wake)).toBe(1);
	});
});

describe('groups through a schedule', () => {
	const calls = scheduleCalls(client);

	test('an occurrence goes to the default group', async () => {
		await calls.upsert('digest', 1000);
		const groups = { concurrency: 2 };
		expect(await calls.fire('digest', 1000, 2000, -1, groups)).toBe(1);
		const id = 'schedule:digest:1000';
		expect(await members(keys.ready)).toEqual([id]);
		expect(await members(`${keys.group}:ready`)).toEqual([id]);
		expect(
			await client().send('LRANGE', [keys.groupsReady, '0', '-1']),
		).toEqual(['']);
		await expectGroupState(client(), keys, 2);
	});
});

describe('the marker guards every transition', () => {
	test('cancel, remove, retry and fire refuse a mismatch and write nothing', async () => {
		await addGrouped(client(), keys, 1, [{ id: 'a1', group: 'A' }]);
		const calls = scheduleCalls(client);
		await calls.upsert('digest', 1000);
		const before = (await scan(client(), 'queue:*')).sort();
		const plain = bindQueue(client(), mailQueue);
		const sizes = async () =>
			JSON.stringify([
				await members(keys.ready),
				await members(`${keys.group}A:ready`),
				await members(keys.schedules),
			]);
		const sized = await sizes();
		const calls_: [string, () => Promise<unknown>][] = [
			['cancel', () => plain.cancel('a1')],
			['remove', () => plain.remove('a1')],
			['retry', () => plain.retry('a1')],
			['fire', () => calls.fire('digest', 1000, 2000)],
		];
		for (const [name, call] of calls_) {
			const error = await rejection(call());
			if (name === 'fire') expect(String(error)).toMatch(/groups mismatch/);
			else expect((error as { code?: string }).code).toBe('GROUPS_MISMATCH');
		}
		expect(await sizes()).toBe(sized);
		expect((await scan(client(), 'queue:*')).sort()).toEqual(before);
	});
});

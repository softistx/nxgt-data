import { describe, expect, test } from 'bun:test';
import {
	eventually,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { addGrouped, grouped, scan } from '../../../test/group-state';
import { rejection } from '../../../test/rejection';
import { QueueError } from '../../errors/queue-error';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from './claim';
import { complete, fail } from './settle';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const boom = { name: 'x', message: 'boom' };
const llen = async (key: string) => Number(await client().send('LLEN', [key]));

/** Everything the scripts write, in a form that compares. */
async function snapshot(): Promise<string> {
	const out: Record<string, unknown> = {};
	for (const key of (await scan(client(), 'queue:*')).sort()) {
		const type = await client().send('TYPE', [key]);
		if (type === 'hash') out[key] = await client().send('HGETALL', [key]);
		else if (type === 'zset')
			out[key] = await client().send('ZRANGE', [key, '0', '-1', 'WITHSCORES']);
		else if (type === 'list')
			out[key] = await client().send('LRANGE', [key, '0', '-1']);
		else if (type === 'set') out[key] = await client().send('SMEMBERS', [key]);
		else out[key] = await client().get(key);
	}
	return JSON.stringify(out);
}

describe('the groups mode marker', () => {
	test('the first call sets it, and a call with the same mode passes', async () => {
		expect(await client().get(keys.groupsMode)).toBeNull();
		await addGrouped(client(), keys, 2, [{ id: 'a1', group: 'A' }]);
		expect(await client().get(keys.groupsMode)).toBe('1:2');
		const reply = await claim(client(), keys, 1, 30_000, undefined, {
			concurrency: 2,
		});
		expect(reply.jobs).toHaveLength(1);
	});

	test('an ungrouped call sets 0', async () => {
		await claim(client(), keys, 1, 30_000, undefined);
		expect(await client().get(keys.groupsMode)).toBe('0');
	});

	test('a grouped claim on an ungrouped queue is refused, nothing written', async () => {
		await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
		const before = await snapshot();
		const error = await rejection(
			claim(client(), keys, 1, 30_000, undefined, { concurrency: 1 }),
		);
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('GROUPS_MISMATCH');
		expect((error as QueueError).message).toBe(
			'claim on "mails": the queue was started with no groups and this process has groups { concurrency: 1 }; every process must share groups (drain the queue and delete queue:{mails}:groups:mode to change it)',
		);
		expect(await snapshot()).toBe(before);
	});

	test('an ungrouped claim on a grouped queue is refused, nothing written', async () => {
		await addGrouped(client(), keys, 0, [{ id: 'a1', group: 'A' }]);
		const before = await snapshot();
		const error = await rejection(claim(client(), keys, 1, 30_000, undefined));
		expect((error as QueueError).message).toContain(
			'started with groups {} and this process has no groups',
		);
		expect(await snapshot()).toBe(before);
	});

	test('another concurrency is refused on claim, complete, fail and add', async () => {
		await addGrouped(client(), keys, 1, [
			{ id: 'a1', group: 'A' },
			{ id: 'a2', group: 'A' },
		]);
		const [job] = (
			await claim(client(), keys, 1, 30_000, undefined, { concurrency: 1 })
		).jobs;
		if (!job) throw new Error('not claimed');
		const before = await snapshot();
		const two = grouped(2);
		const refused = [
			rejection(
				claim(client(), keys, 1, 30_000, undefined, { concurrency: 2 }),
			),
			rejection(
				complete(client(), keys, two, 'a1', job.token, undefined, false),
			),
			rejection(fail(client(), keys, two, 'a1', job.token, boom, null, false)),
			rejection(bindQueue(client(), two).add({ to: 'b' }, { id: 'b' })),
		];
		for (const error of await Promise.all(refused)) {
			expect((error as QueueError).code).toBe('GROUPS_MISMATCH');
			expect((error as QueueError).message).toContain(
				'groups { concurrency: 1 }',
			);
			expect((error as QueueError).message).toContain(
				'groups { concurrency: 2 }',
			);
		}
		expect(await snapshot()).toBe(before);
		expect(await client().get(`${keys.group}A:active`)).toBe('1');
	});

	test('a worker whose claim is refused emits error and does not spin', async () => {
		await client().set(keys.groupsMode, '0');
		const worker = bindQueue(client(), grouped(1)).work(() => undefined);
		try {
			const errors: unknown[] = [];
			worker.on('error', (e) => void errors.push(e));
			await eventually(() => errors.length > 0, true);
			expect((errors[0] as QueueError).code).toBe('GROUPS_MISMATCH');
			const before = await scriptCalls(client());
			await Bun.sleep(300);
			expect((await scriptCalls(client())) - before).toBeLessThanOrEqual(1);
			expect(await llen(keys.wake)).toBe(0);
		} finally {
			await worker.close();
		}
	});
});

import { describe, expect, test } from 'bun:test';
import {
	eventually,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import * as queues from '../../../test/wiring/queues';
import { JobError } from '../../errors/job-error';
import type { QueueError } from '../../errors/queue-error';
import { defineRedis } from '../../wiring/config/define-redis';
import { openRedis } from '../../wiring/open-redis';
import { queueKeys } from '../keys';
import type { JobContext } from '../worker/types';
import { bindQueue } from './bind-queue';

const servers = useRedis();
const { track } = servers;
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const state = (id: string) => client().hget(keys.job(id), 'state');
const once = { ...mailQueue, attempts: 1 } as typeof mailQueue;

describe('retry(id, { fresh })', () => {
	test('retry(id, { fresh: true }) runs every step again; retry(id) resumes', async () => {
		const queue = bindQueue(client(), once);
		const calls = { a: 0, b: 0, c: 0, after: 0 };
		const keysSeen: string[] = [];
		let runs = 0;
		const worker = queue.work((async (job: JobContext<never>) => {
			runs++;
			await job.step('a', () => ++calls.a);
			await job.step('b', () => ++calls.b);
			await job.step('c', () => ++calls.c);
			keysSeen.push(job.key('a'));
			calls.after++;
			if (runs <= 2) throw new Error('boom');
		}) as never);
		try {
			await queue.add({ to: 'a' }, { id: 'a' });
			await eventually(() => state('a'), 'failed');
			expect(calls).toEqual({ a: 1, b: 1, c: 1, after: 1 });
			// Resuming: the steps are stored, only the code after them runs.
			await queue.retry('a');
			await eventually(() => runs, 2);
			await eventually(() => state('a'), 'failed');
			expect(calls).toEqual({ a: 1, b: 1, c: 1, after: 2 });
			// Fresh: every step's fn is called again.
			await queue.retry('a', { fresh: true });
			await eventually(() => state('a'), 'completed');
			expect(calls).toEqual({ a: 2, b: 2, c: 2, after: 3 });
			expect(keysSeen).toHaveLength(3);
			expect(new Set(keysSeen).size).toBe(1);
		} finally {
			await worker.close({ grace: 100 });
		}
	});

	test('retry with fresh that is not true or false is a TypeError before any round trip', async () => {
		const queue = bindQueue(client(), mailQueue);
		const before = await scriptCalls(client());
		for (const fresh of ['yes', 1, 0, null, {}]) {
			const error = await rejection(queue.retry('a', { fresh } as never));
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(
				'retry on "mails": fresh is true or false',
			);
		}
		expect(await scriptCalls(client())).toBe(before);
	});

	test('retry ignores other option keys as add does, and fresh: false is accepted', async () => {
		const queue = bindQueue(client(), once);
		await queue.add({ to: 'a' }, { id: 'a' });
		// Past the checks, the call reaches the script: a waiting job is not failed.
		const error = (await rejection(
			queue.retry('a', { fresh: false, other: 1 } as never),
		)) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
	});

	test('retry with fresh passes through after redis.close()', async () => {
		const redis = track(
			await openRedis(defineRedis({ client: client(), queues })),
		);
		const worker = redis.queues.mails.work(() => {
			throw new JobError('no', { retry: false });
		});
		const handle = await redis.queues.mails.add({ to: 'a@b.c' });
		await eventually(
			async () => (await redis.queues.mails.get(handle.id))?.state,
			'failed',
		);
		await worker.close({ grace: 100 });
		await client().hset(keys.job(handle.id), 'step:x', '1');
		await redis.close();
		await redis.queues.mails.retry(handle.id, { fresh: true });
		expect(await client().hget(keys.job(handle.id), 'step:x')).toBeNull();
		const error = (await rejection(
			redis.queues.mails.retry(handle.id, { fresh: true }),
		)) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
	});
});

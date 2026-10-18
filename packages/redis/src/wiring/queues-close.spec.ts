import { describe, expect, test } from 'bun:test';
import { gate, settled, subscribed, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import * as queues from '../../test/wiring/queues';
import type { QueueError } from '../errors/queue-error';
import { defineRedis } from './config/define-redis';
import { openRedis } from './open-redis';

const servers = useRedis();
const { track } = servers;
const client = () => servers.redis.client;

/** Handed-in client: the Redis opens no connection of its own. */
const handed = (prefix?: string) =>
	defineRedis({ client: client(), prefix, queues });

/** Owned connection, opened from the server's uri. */
const owned = (prefix?: string) =>
	defineRedis({ uri: servers.redis.uri, prefix, queues });

async function connections() {
	const list = (await client().send('CLIENT', ['LIST'])) as string;
	return list.split('\n').filter((line) => line.trim() !== '').length;
}

const to = (address: string) => ({ to: address });

describe('closing a Redis with queues', () => {
	test('redis.close() waits for a running job within the grace', async () => {
		const redis = track(await openRedis(handed()));
		const started = gate();
		const release = gate();
		redis.queues.mails.work(async () => {
			started.open();
			await release.opened;
			return { messageId: 'm1' };
		});
		const handle = await redis.queues.mails.add(to('a@b.c'));
		await started.opened;
		const order: string[] = [];
		const closing = redis.close().then(() => order.push('closed'));
		// Held: close must be waiting on the job, not past it.
		await Promise.race([closing, Bun.sleep(30)]);
		expect(order).toEqual([]);
		order.push('released');
		release.open();
		await closing;
		expect(order).toEqual(['released', 'closed']);
		// The job finished within the grace, not aborted: its result is stored.
		const job = await redis.queues.mails.get(handle.id);
		expect(job?.state).toBe('completed');
		expect(job?.result).toEqual({ messageId: 'm1' });
	});

	test('a finished pending when its job completes during the grace resolves with the result, never CLOSED', async () => {
		const redis = track(await openRedis(handed()));
		const started = gate();
		const release = gate();
		redis.queues.mails.work(async () => {
			started.open();
			await release.opened;
			return { messageId: 'm1' };
		});
		const handle = await redis.queues.mails.add(to('a@b.c'));
		await started.opened;
		const order: string[] = [];
		const finished = settled(handle.finished()).then((outcome) => {
			order.push('finished');
			return outcome;
		});
		await subscribed(client(), 'queue:{mails}:events');
		const closing = redis.close().then(() => order.push('closed'));
		release.open();
		await closing;
		expect(await finished).toEqual({ value: { messageId: 'm1' } });
		expect(order).toEqual(['finished', 'closed']);
	});

	test('redis.close({ grace: 50 }) aborts a job that ignores its signal with CLOSED, and resolves', async () => {
		const redis = track(await openRedis(handed()));
		const started = gate();
		const hold = gate();
		let code: unknown;
		redis.queues.mails.work(async (job) => {
			job.signal.addEventListener('abort', () => {
				code = (job.signal.reason as QueueError).code;
			});
			started.open();
			await hold.opened;
			return { messageId: 'm1' };
		});
		await redis.queues.mails.add(to('a@b.c'));
		await started.opened;
		await redis.close({ grace: 50 });
		expect(code).toBe('CLOSED');
		hold.open();
	});

	test('a handler adding to another wired queue during the grace succeeds', async () => {
		const redis = track(await openRedis(handed()));
		const started = gate();
		const release = gate();
		const added = gate();
		let outcome: unknown;
		redis.queues.mails.work(async () => {
			started.open();
			await release.opened;
			outcome = await settled(redis.queues.digest.add({ day: 'mon' }));
			added.open();
			return { messageId: 'm1' };
		});
		await redis.queues.mails.add(to('a@b.c'));
		await started.opened;
		const closing = redis.close();
		release.open();
		await added.opened;
		await closing;
		expect(outcome).toHaveProperty('value');
		expect((await redis.queues.digest.counts()).waiting).toBe(1);
	});

	test('add after close rejects CLOSED; work during close throws CLOSED', async () => {
		const redis = track(await openRedis(handed()));
		const started = gate();
		const release = gate();
		redis.queues.mails.work(async () => {
			started.open();
			await release.opened;
			return { messageId: 'm1' };
		});
		await redis.queues.mails.add(to('a@b.c'));
		await started.opened;
		const closing = redis.close();
		let thrown: unknown;
		try {
			redis.queues.mails.work(() => ({ messageId: 'x' }));
		} catch (error) {
			thrown = error;
		}
		expect((thrown as QueueError).code).toBe('CLOSED');
		release.open();
		await closing;
		const refused = (await rejection(
			redis.queues.digest.add({ day: 'mon' }),
		)) as QueueError;
		expect(refused.code).toBe('CLOSED');
	});

	test('a finished pending across redis.close() rejects CLOSED, and CLIENT LIST is back to baseline', async () => {
		const baseline = await connections();
		const redis = track(await openRedis(handed()));
		const handle = await redis.queues.mails.add(to('a@b.c'));
		const pending = rejection(handle.finished());
		await redis.close();
		expect(((await pending) as QueueError).code).toBe('CLOSED');
		expect(await connections()).toBe(baseline);
	});

	test('an owned connection: after close, CLIENT LIST is back to baseline', async () => {
		const baseline = await connections();
		const redis = track(await openRedis(owned()));
		const worker = redis.queues.mails.work(() => ({ messageId: 'm1' }));
		const handle = await redis.queues.mails.add(to('a@b.c'));
		expect(await handle.finished()).toEqual({ messageId: 'm1' });
		await worker.idle();
		expect(await connections()).toBeGreaterThan(baseline);
		await redis.close();
		expect(await connections()).toBe(baseline);
	});

	test('close() twice returns one promise, the second grace ignored', async () => {
		const redis = track(await openRedis(handed()));
		const first = redis.close({ grace: 20 });
		const second = redis.close({ grace: 60_000 });
		expect(second).toBe(first);
		await first;
		expect(redis.close()).toBe(first);
	});

	test('a malformed grace rejects and closes nothing', async () => {
		const redis = track(await openRedis(handed()));
		const refused = await rejection(redis.close({ grace: '10min' as never }));
		expect(refused).toBeInstanceOf(TypeError);
		expect((refused as Error).message).not.toContain('10min');
		await redis.queues.mails.add(to('a@b.c'));
		await redis.close();
	});

	test('[Symbol.asyncDispose] closes the workers too', async () => {
		const baseline = await connections();
		const redis = track(await openRedis(owned()));
		redis.queues.mails.work(() => ({ messageId: 'm1' }));
		const handle = await redis.queues.mails.add(to('a@b.c'));
		await handle.finished();
		await redis[Symbol.asyncDispose]();
		expect(await connections()).toBe(baseline);
		const refused = (await rejection(
			redis.queues.mails.add(to('a@b.c')),
		)) as QueueError;
		expect(refused.code).toBe('CLOSED');
	});
});

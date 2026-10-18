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

const to = (address: string) => ({ to: address });

describe('two Redis objects sharing one queue definition', () => {
	test('two Redis objects, prefixes a and b, one definition: separate keys, closing a leaves b working', async () => {
		const a = track(await openRedis(handed('a')));
		const b = track(await openRedis(handed('b')));
		await a.queues.mails.add(to('a@b.c'), { id: 'j1' });
		expect(await client().exists('queue:{a:mails}:job:j1')).toBe(true);
		expect(await client().exists('queue:{b:mails}:job:j1')).toBe(false);
		await a.close();
		const refused = (await rejection(
			a.queues.mails.add(to('a@b.c')),
		)) as QueueError;
		expect(refused.code).toBe('CLOSED');
		const worker = b.queues.mails.work(() => ({ messageId: 'm1' }));
		const handle = await b.queues.mails.add(to('a@b.c'));
		expect(await handle.finished()).toEqual({ messageId: 'm1' });
		await worker.close();
	});

	test('closing a while b has a running job and a pending finished leaves b untouched', async () => {
		const a = track(await openRedis(handed('a')));
		const b = track(await openRedis(handed('b')));
		const startedA = gate();
		const releaseA = gate();
		const startedB = gate();
		const releaseB = gate();
		a.queues.mails.work(async () => {
			startedA.open();
			await releaseA.opened;
			return { messageId: 'a1' };
		});
		b.queues.mails.work(async (job) => {
			if (job.id === 'jb') {
				startedB.open();
				await releaseB.opened;
			}
			return { messageId: `b:${job.id}` };
		});
		const handleA = await a.queues.mails.add(to('a@b.c'), { id: 'ja' });
		const handleB = await b.queues.mails.add(to('a@b.c'), { id: 'jb' });
		await Promise.all([startedA.opened, startedB.opened]);
		const finishedA = settled(handleA.finished());
		const finishedB = settled(handleB.finished());
		await subscribed(client(), 'queue:{a:mails}:events');
		await subscribed(client(), 'queue:{b:mails}:events');
		const closing = a.close();
		releaseA.open();
		await closing;
		// a's own finished ended with its result; b's is still waiting.
		expect(await finishedA).toEqual({ value: { messageId: 'a1' } });
		expect(
			await Promise.race([finishedB, Bun.sleep(30).then(() => 'held')]),
		).toBe('held');
		releaseB.open();
		expect(await finishedB).toEqual({ value: { messageId: 'b:jb' } });
		// b's worker was not closed: it claims a job added after a's close.
		const next = await b.queues.mails.add(to('a@b.c'), { id: 'jb2' });
		expect(await next.finished()).toEqual({ messageId: 'b:jb2' });
	});
});

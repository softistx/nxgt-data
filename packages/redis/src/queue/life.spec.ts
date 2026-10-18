import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { subscribed, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { QueueError } from '../errors/queue-error';
import { bindQueue, bindQueueWith } from './bind-queue';
import { defineQueue } from './define-queue';
import { queueKeys } from './keys';
import { closeLife, openLife, trackWorker } from './life';
import type { Worker } from './worker/types';

const servers = useRedis();
const client = () => servers.redis.client;

const mails = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string() }),
	result: z.object({ count: z.number() }),
});
const keys = queueKeys('mails');
const to = (address: string) => ({ to: address });

function wired() {
	const life = openLife();
	const queue = bindQueueWith(client(), mails, { prefix: undefined, life });
	return { life, queue };
}

async function connections() {
	const list = (await client().send('CLIENT', ['LIST'])) as string;
	return list.split('\n').filter((line) => line.trim() !== '').length;
}

/** A worker double: records its closes, and rejects when told to. */
function fake(reject?: Error) {
	const closes: unknown[] = [];
	const worker = {
		close: async (options?: unknown) => {
			closes.push(options);
			if (reject) throw reject;
		},
		on: () => () => undefined,
		idle: async () => undefined,
		[Symbol.asyncDispose]: async () => undefined,
	} as unknown as Worker;
	return { worker, closes };
}

describe('a wired queue and its Redis closing', () => {
	test('add, addMany and finished reject CLOSED once closed; work throws CLOSED once closing', async () => {
		const { life, queue } = wired();
		const handle = await queue.add(to('a'), { id: 'a' });
		await closeLife(life, undefined);
		const messages = {
			add: 'add on "mails": the Redis is closed',
			addMany: 'addMany on "mails": the Redis is closed',
			finished: 'finished on "mails": the Redis is closed',
			work: 'work on "mails": the Redis is closed',
		};
		for (const [call, run] of [
			['add', () => queue.add(to('b'))],
			['addMany', () => queue.addMany([{ data: to('b') }])],
			['finished', () => handle.finished()],
		] as const) {
			const error = await rejection(run());
			expect(error).toBeInstanceOf(QueueError);
			expect((error as QueueError).code).toBe('CLOSED');
			expect((error as QueueError).queue).toBe('mails');
			expect((error as QueueError).message).toBe(messages[call]);
		}
		expect(() => queue.work(() => ({ count: 1 }))).toThrow(messages.work);
		const closing = openLife();
		closing.state = 'closing';
		const other = bindQueueWith(client(), mails, {
			prefix: undefined,
			life: closing,
		});
		try {
			other.work(() => ({ count: 1 }));
			throw new Error('work did not throw');
		} catch (error) {
			expect((error as QueueError).code).toBe('CLOSED');
			expect((error as QueueError).message).toBe(
				'work on "mails": the Redis is closing',
			);
		}
	});

	test('add still works while closing', async () => {
		const { life, queue } = wired();
		life.state = 'closing';
		const handle = await queue.add(to('a'), { id: 'a' });
		expect(handle.id).toBe('a');
		expect(
			(await queue.addMany([{ data: to('b'), options: { id: 'b' } }])).length,
		).toBe(1);
	});

	test('a finished pending at close rejects CLOSED with the job id', async () => {
		const { life, queue } = wired();
		const handle = await queue.add(to('a'), { id: 'a' });
		const pending = rejection(handle.finished());
		await subscribed(client(), keys.events);
		await closeLife(life, undefined);
		const error = (await pending) as QueueError;
		expect(error).toBeInstanceOf(QueueError);
		expect(error.code).toBe('CLOSED');
		expect(error.job).toBe('a');
		expect(error.message).toBe(
			'finished on "mails": job "a" was pending when the Redis closed',
		);
	});

	test('closeLife resolves only after every pending finished unlistened', async () => {
		const { life, queue } = wired();
		const handle = await queue.add(to('a'), { id: 'a' });
		const baseline = await connections();
		const pending = rejection(handle.finished());
		await subscribed(client(), keys.events);
		expect(await connections()).toBe(baseline + 1);
		await closeLife(life, undefined);
		expect(life.waits.size).toBe(0);
		expect(await connections()).toBe(baseline);
		await pending;
	});

	test('closeLife closes every tracked worker, and a worker closed by hand leaves the set', async () => {
		const life = openLife();
		const a = fake();
		const b = fake();
		const byHand = fake();
		trackWorker(life, a.worker);
		trackWorker(life, b.worker);
		const tracked = trackWorker(life, byHand.worker);
		expect(life.workers.size).toBe(3);
		await tracked.close({ grace: 5 });
		expect(life.workers.size).toBe(2);
		expect(byHand.closes).toEqual([{ grace: 5 }]);
		await closeLife(life, 250);
		expect(a.closes).toEqual([{ grace: 250 }]);
		expect(b.closes).toEqual([{ grace: 250 }]);
		expect(byHand.closes.length).toBe(1);
		expect(life.workers.size).toBe(0);
		expect(life.state).toBe('closed');
	});

	test('a worker whose close rejects does not keep the others open, and its error is rethrown last', async () => {
		const life = openLife();
		const boom = new Error('boom');
		const bad = fake(boom);
		const good = fake();
		trackWorker(life, bad.worker);
		trackWorker(life, good.worker);
		const error = await rejection(closeLife(life, undefined));
		expect(error).toBe(boom);
		expect(good.closes.length).toBe(1);
		expect(life.state).toBe('closed');
	});

	test('admin calls pass through after close', async () => {
		const { life, queue } = wired();
		await queue.add(to('a'), { id: 'a' });
		await closeLife(life, undefined);
		expect((await queue.counts()).waiting).toBe(1);
		expect((await queue.get('a'))?.id).toBe('a');
		expect((await queue.list('waiting')).length).toBe(1);
		await queue.cancel('a');
		expect((await queue.counts()).waiting).toBe(0);
	});

	test('a queue bound by hand never throws CLOSED', async () => {
		const queue = bindQueue(client(), mails);
		const handle = await queue.add(to('a'), { id: 'a' });
		await queue.addMany([{ data: to('b'), options: { id: 'b' } }]);
		const worker = queue.work(() => ({ count: 1 }));
		expect(await handle.finished()).toEqual({ count: 1 });
		await worker.close();
	});
});

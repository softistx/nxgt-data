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

/** What a {@link fake} worker does around its close. */
type FakeOptions = {
	reject?: Error;
	throws?: Error;
	hold?: Promise<void>;
	during?: () => Promise<void>;
};

/** A worker double whose close is memoised, as a real one's is: `closes` counts the first call's options and later calls. */
function fake(options: FakeOptions = {}) {
	const closes: unknown[] = [];
	let first: Promise<void> | undefined;
	const worker = {
		close: (given?: unknown) => {
			closes.push(given);
			if (options.throws) throw options.throws;
			first ??= (async () => {
				await options.during?.();
				await options.hold;
				if (options.reject) throw options.reject;
			})();
			return first;
		},
		on: () => () => undefined,
		idle: async () => undefined,
		[Symbol.asyncDispose]: async () => undefined,
	} as unknown as Worker;
	return { worker, closes };
}

/** A promise settled by hand. */
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
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

	test('a worker whose close rejects does not keep the others open: its error is rethrown after both phases, the first one when two reject', async () => {
		const life = openLife();
		const boom = new Error('boom');
		const bad = fake({ reject: boom });
		const worse = fake({ reject: new Error('worse') });
		const good = fake();
		trackWorker(life, bad.worker);
		trackWorker(life, worse.worker);
		trackWorker(life, good.worker);
		const error = await rejection(closeLife(life, undefined));
		expect(error).toBe(boom);
		expect(good.closes.length).toBe(1);
		expect(life.state).toBe('closed');
		expect(life.waits.size).toBe(0);
	});

	test('admin calls pass through after close', async () => {
		const { life, queue } = wired();
		await queue.add(to('a'), { id: 'a' });
		await closeLife(life, undefined);
		expect((await queue.counts()).waiting).toBe(1);
		expect((await queue.get('a'))?.id).toBe('a');
		expect((await queue.list('waiting')).length).toBe(1);
		expect(await queue.remove('a')).toBeUndefined();
		expect((await queue.counts()).waiting).toBe(0);
		const error = await rejection(queue.retry('a'));
		expect((error as QueueError).code).toBe('NOT_FOUND');
	});

	test('a sync throw from a worker close is caught like a rejection, and phase 2 still runs', async () => {
		const life = openLife();
		const boom = new Error('sync');
		trackWorker(life, fake({ throws: boom }).worker);
		const good = fake();
		trackWorker(life, good.worker);
		const error = await rejection(closeLife(life, undefined));
		expect(error).toBe(boom);
		expect(good.closes.length).toBe(1);
		expect(life.state).toBe('closed');
	});

	test('phase order: add works and a finished stays pending while the workers close; the finished rejects CLOSED after', async () => {
		const { life, queue } = wired();
		const seen: { state?: string; added?: string; early?: boolean } = {};
		let pending: Promise<unknown> | undefined;
		let settled = false;
		const { worker } = fake({
			during: async () => {
				seen.state = life.state;
				const handle = await queue.add(to('a'), { id: 'a' });
				seen.added = handle.id;
				pending = rejection(handle.finished()).then((error) => {
					settled = true;
					return error;
				});
				await subscribed(client(), keys.events);
				seen.early = settled;
			},
		});
		trackWorker(life, worker);
		await closeLife(life, undefined);
		expect(seen).toEqual({ state: 'closing', added: 'a', early: false });
		const error = (await pending) as QueueError;
		expect(error.code).toBe('CLOSED');
	});

	test('addMany stops with CLOSED between chunks, and what was sent stays written', async () => {
		const life = openLife();
		const real = client();
		const proxy = new Proxy(real, {
			get(target, prop) {
				if (prop === 'evalsha') {
					return async (...args: Parameters<typeof real.evalsha>) => {
						const reply = await target.evalsha(...args);
						life.state = 'closed';
						return reply;
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const queue = bindQueueWith(proxy, mails, { prefix: undefined, life });
		const items = Array.from({ length: 501 }, (_, i) => ({
			data: to('a'),
			options: { id: `j${i}` },
		}));
		const error = (await rejection(queue.addMany(items))) as QueueError;
		expect(error.code).toBe('CLOSED');
		expect((await bindQueue(real, mails).counts()).waiting).toBe(500);
	});

	test('a queue bound by hand never throws CLOSED', async () => {
		const queue = bindQueue(client(), mails);
		const handle = await queue.add(to('a'), { id: 'a' });
		await queue.addMany([{ data: to('b'), options: { id: 'b' } }]);
		const worker = queue.work(() => ({ count: 1 }));
		expect(await handle.finished()).toEqual({ count: 1 });
		await worker.close();
	});

	test('a worker closed by hand stays tracked until its close resolves, and closeLife waits for it', async () => {
		const life = openLife();
		const gate = deferred();
		const held = fake({ hold: gate.promise });
		const tracked = trackWorker(life, held.worker);
		const byHand = tracked.close();
		expect(life.workers.size).toBe(1);
		let closed = false;
		const all = closeLife(life, undefined).then(() => {
			closed = true;
		});
		await Bun.sleep(30);
		expect(closed).toBe(false);
		gate.release();
		await byHand;
		await all;
		expect(closed).toBe(true);
		expect(life.workers.size).toBe(0);
	});

	test('a close refused for a bad grace leaves the worker tracked, and closeLife closes it', async () => {
		const life = openLife();
		const refused = fake({ reject: new TypeError('bad grace') });
		const tracked = trackWorker(life, refused.worker);
		const error = await rejection(tracked.close({ grace: -1 }));
		expect((error as Error).message).toBe('bad grace');
		expect(life.workers.has(refused.worker)).toBe(true);
		const closing = rejection(closeLife(life, 10));
		expect(((await closing) as Error).message).toBe('bad grace');
		expect(refused.closes).toEqual([{ grace: -1 }, { grace: 10 }]);
	});

	test('asyncDispose on a tracked worker leaves the set once the close ends', async () => {
		const life = openLife();
		const gate = deferred();
		const tracked = trackWorker(life, fake({ hold: gate.promise }).worker);
		const disposed = tracked[Symbol.asyncDispose]();
		expect(life.workers.size).toBe(1);
		gate.release();
		await disposed;
		expect(life.workers.size).toBe(0);
	});
});

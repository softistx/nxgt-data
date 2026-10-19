import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { fake } from '../../../test/fake-worker';
import { subscribed, useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { QueueError } from '../../errors/queue-error';
import { defineQueue } from '../definition/define-queue';
import { queueKeys } from '../keys';
import { bindQueue, bindQueueWith } from './bind-queue';
import { closeLife, openLife, trackWorker } from './life';

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
		expect(await queue.cancel('a')).toBe(false);
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
});

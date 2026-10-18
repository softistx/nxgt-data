import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { eventually, subscribed, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { QueueError } from '../errors/queue-error';
import { bindQueue } from './bind-queue';
import { defineQueue } from './define-queue';
import { decodeResult, encodeResult } from './encode';
import { jobHandle } from './handle';
import { queueKeys } from './keys';
import { claim } from './scripts/claim';
import { progress } from './scripts/progress';
import { complete, fail } from './scripts/settle';

const servers = useRedis();
const client = () => servers.redis.client;

const sent = defineQueue({
	name: 'sent',
	schema: z.object({ to: z.string() }),
	result: z.object({ count: z.number() }),
	lease: 300,
});
const volatile = defineQueue({
	name: 'volatile',
	schema: z.object({ to: z.string() }),
	result: z.object({ count: z.number() }),
	keepCompleted: false,
});
const keys = queueKeys('sent');
const to = (address: string) => ({ to: address });

async function connections() {
	const list = (await client().send('CLIENT', ['LIST'])) as string;
	return list.split('\n').filter((line) => line.trim() !== '').length;
}

/** Claims the one job of `queue`, as a worker would. */
async function take(queue = sent) {
	const [job] = (await claim(client(), queueKeys(queue.name), 1, 30_000)).jobs;
	if (!job) throw new Error('nothing to claim');
	return job;
}

const finish = (queue: typeof sent, id: string, token: string, json: string) =>
	complete(client(), queueKeys(queue.name), queue, id, token, json, false);

/** Resolves once the handles' SUBSCRIBE is live: one shared connection per client. */
const listening = (channel = keys.events) => subscribed(client(), channel);

describe('the job handle', () => {
	test('finished resolves with the result a worker returned', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const result = handle.finished();
		await listening();
		await finish(sent, 'a', job.token, '{"count":3}');
		expect(await result).toEqual({ count: 3 });
	});

	test('finished after the job already completed resolves from the stored result', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		await finish(sent, 'a', job.token, '{"count":4}');
		expect(await handle.finished()).toEqual({ count: 4 });
	});

	test('finished on a failed job rejects FAILED with lastError, and the message holds no error text', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		await fail(
			client(),
			keys,
			sent,
			'a',
			job.token,
			{ name: 'Boom', message: 'secret detail' },
			null,
			false,
		);
		const error = (await rejection(handle.finished())) as QueueError;
		expect(error).toBeInstanceOf(QueueError);
		expect(error.code).toBe('FAILED');
		expect(error.lastError).toEqual({ name: 'Boom', message: 'secret detail' });
		expect(error.queue).toBe('sent');
		expect(error.job).toBe('a');
		expect(error.message).toContain('"sent"');
		expect(error.message).toContain('"a"');
		expect(error.message).not.toContain('secret detail');
		expect(error.message).not.toContain('Boom');
	});

	test('finished rejects FAILED when the failure is published while waited on', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const waited = rejection(handle.finished());
		await listening();
		await fail(
			client(),
			keys,
			sent,
			'a',
			job.token,
			{ name: 'Boom', message: 'late' },
			null,
			false,
		);
		const error = (await waited) as QueueError;
		expect(error.code).toBe('FAILED');
		expect(error.lastError).toEqual({ name: 'Boom', message: 'late' });
	});

	test('finished rejects CANCELED when the job is canceled while waited on', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const waited = rejection(handle.finished());
		await listening();
		expect(await handle.cancel()).toBe(true);
		const error = (await waited) as QueueError;
		expect(error.code).toBe('CANCELED');
		expect(error.job).toBe('a');
	});

	test('finished on an unknown or removed job rejects NOT_FOUND at once', async () => {
		const queue = bindQueue(client(), sent);
		const ghost = jobHandle(client(), sent, keys, 'ghost', false);
		expect(((await rejection(ghost.finished())) as QueueError).code).toBe(
			'NOT_FOUND',
		);
		const handle = await queue.add(to('a'), { id: 'a' });
		await queue.remove('a');
		const error = (await rejection(handle.finished())) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
		expect(error.message).toContain('"a"');
	});

	test('finished with timeout rejects WAIT_TIMEOUT and leaves no listener', async () => {
		const before = await connections();
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const error = (await rejection(
			handle.finished({ timeout: 100 }),
		)) as QueueError;
		expect(error.code).toBe('WAIT_TIMEOUT');
		await eventually(connections, before);
	});

	test('finished refuses a malformed timeout with a TypeError', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const error = await rejection(handle.finished({ timeout: -5 }));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).not.toContain('-5');
	});

	test('finished resolves with keepCompleted false, from the published result', async () => {
		const handle = await bindQueue(client(), volatile).add(to('a'), {
			id: 'a',
		});
		const job = await take(volatile as unknown as typeof sent);
		const result = handle.finished();
		await listening(queueKeys('volatile').events);
		await finish(
			volatile as unknown as typeof sent,
			'a',
			job.token,
			'{"count":9}',
		);
		expect(await result).toEqual({ count: 9 });
	});

	test('finished rejects INVALID when the published result is one the schema refuses', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const waited = rejection(handle.finished());
		await listening();
		await finish(sent, 'a', job.token, '{"count":"many"}');
		const error = (await waited) as QueueError;
		expect(error.code).toBe('INVALID');
		expect(error.message).not.toContain('many');
	});

	test('a missed event is caught by the re-read', async () => {
		await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const spy = spyOnReads();
		const handle = jobHandle(spy.client, sent, keys, 'a', false, 100);
		const result = handle.finished();
		// The first read has been made, and found the job running.
		await eventually(() => spy.reads() >= 1, true);
		// Published on a channel nobody hears, as a dropped connection would lose it.
		await complete(
			client(),
			{ ...keys, events: 'queue:{sent}:elsewhere' },
			sent,
			'a',
			job.token,
			'{"count":7}',
			false,
		);
		expect(await result).toEqual({ count: 7 });
	});

	test('the re-read gives FAILED for a failed job whose event was missed', async () => {
		await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const spy = spyOnReads();
		const handle = jobHandle(spy.client, sent, keys, 'a', false, 100);
		const waited = rejection(handle.finished());
		// The first read has been made, and found the job running.
		await eventually(() => spy.reads() >= 1, true);
		await fail(
			client(),
			{ ...keys, events: 'queue:{sent}:elsewhere' },
			sent,
			'a',
			job.token,
			{ name: 'Boom', message: 'quiet' },
			null,
			false,
		);
		const error = (await waited) as QueueError;
		expect(error.code).toBe('FAILED');
		expect(error.lastError?.message).toBe('quiet');
	});

	test('cancel answers true for a waiting job and false for a finished one', async () => {
		const queue = bindQueue(client(), sent);
		const waiting = await queue.add(to('a'), { id: 'a' });
		expect(await waiting.cancel()).toBe(true);
		expect(await queue.get('a')).toBeUndefined();
		expect(await waiting.cancel()).toBe(false);
		const done = await queue.add(to('b'), { id: 'b' });
		const job = await take();
		await finish(sent, 'b', job.token, '{"count":1}');
		expect(await done.cancel()).toBe(false);
		expect(await queue.cancel('b')).toBe(false);
		await queue.add(to('c'), { id: 'c' });
		expect(await queue.cancel('c')).toBe(true);
		expect(await queue.cancel('unknown')).toBe(false);
	});

	test('get shows progress and the decoded result', async () => {
		const queue = bindQueue(client(), sent);
		await queue.add(to('a'), { id: 'a' });
		const job = await take();
		expect((await queue.get('a'))?.progress).toBe(0);
		expect((await queue.get('a'))?.result).toBeUndefined();
		await progress(client(), keys, 'a', job.token, 40);
		expect((await queue.get('a'))?.progress).toBe(40);
		await finish(sent, 'a', job.token, '{"count":5}');
		const view = await queue.get('a');
		expect(view?.result).toEqual({ count: 5 });
		expect((await queue.list('completed'))[0]?.result).toEqual({ count: 5 });
	});

	test('a result the schema no longer reads is left out of the view', async () => {
		const queue = bindQueue(client(), sent);
		await queue.add(to('a'), { id: 'a' });
		const job = await take();
		await finish(sent, 'a', job.token, '{"count":"x"}');
		const view = await queue.get('a');
		expect(view?.state).toBe('completed');
		expect(view?.result).toBeUndefined();
	});
});

/** A client that counts the job-state reads and can answer the next ones from a script. */
function spyOnReads() {
	let reads = 0;
	const script: (string | null)[][] = [];
	const real = client();
	const spy = new Proxy(real, {
		get(target, prop) {
			if (prop === 'hmget') {
				return (...args: Parameters<typeof real.hmget>) => {
					reads++;
					const scripted = script.shift();
					return scripted ? Promise.resolve(scripted) : target.hmget(...args);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { client: spy, script, reads: () => reads };
}

describe('the handle against stray and missed messages', () => {
	const channel = 'queue:{sent}:events';
	const publish = (text: string) => client().send('PUBLISH', [channel, text]);

	test('a message for another id, and malformed messages, are ignored', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const result = handle.finished();
		await listening();
		await publish('{"type":"completed","id":"other","result":{"count":1}}');
		await publish('not json');
		await publish('null');
		await publish('{"type":"mystery","id":"a"}');
		await publish('{"type":"completed","id":"a","result":{"count":1}}');
		expect(await result).toEqual({ count: 1 });
		void job;
	});

	test('a failed event without an error gives FAILED with no lastError', async () => {
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const waited = rejection(handle.finished());
		await listening();
		await publish('{"type":"failed","id":"a"}');
		const error = (await waited) as QueueError;
		expect(error.code).toBe('FAILED');
		expect(error.lastError).toBeUndefined();
	});

	test('finished called twice settles both and leaves no connection', async () => {
		const before = await connections();
		const handle = await bindQueue(client(), sent).add(to('a'), { id: 'a' });
		const job = await take();
		const first = handle.finished();
		const second = handle.finished();
		await listening();
		await finish(sent, 'a', job.token, '{"count":2}');
		expect(await first).toEqual({ count: 2 });
		expect(await second).toEqual({ count: 2 });
		await eventually(connections, before);
	});

	test('with keepCompleted false and the event missed, NOT_FOUND comes after the second absent re-read', async () => {
		await bindQueue(client(), volatile).add(to('a'), { id: 'a' });
		const vkeys = queueKeys('volatile');
		const job = await take(volatile as unknown as typeof sent);
		const spy = spyOnReads();
		const handle = jobHandle(spy.client, volatile, vkeys, 'a', false, 150);
		const started = Date.now();
		const waited = rejection(handle.finished());
		// The first read has been made, and found the job running.
		await eventually(() => spy.reads() >= 1, true);
		await complete(
			client(),
			{ ...vkeys, events: 'queue:{volatile}:elsewhere' },
			volatile as unknown as typeof sent,
			'a',
			job.token,
			'{"count":1}',
			false,
		);
		const error = (await waited) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
		// One re-read at 150 ms is not enough; the second, at 300 ms, is.
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
	});
});

describe('the absent re-read count', () => {
	test('a present re-read between two absent ones restarts the count', async () => {
		const spy = spyOnReads();
		const absent = [null, null, null];
		const present = ['active', null, null];
		// First read present, then absent, present, absent, absent: the reset
		// means the second absent pair is what settles it.
		spy.script.push(present, absent, present, absent, absent);
		const handle = jobHandle(spy.client, sent, keys, 'ghost', false, 30);
		const error = (await rejection(handle.finished())) as QueueError;
		expect(error.code).toBe('NOT_FOUND');
		expect(spy.script.length).toBe(0);
		expect(spy.reads()).toBe(5);
	});
});

describe('a result of undefined', () => {
	const voided = defineQueue({
		name: 'voided',
		schema: z.object({ to: z.string() }),
		result: z.void(),
	});

	test('z.void() reads back undefined, and a required schema finding no result (a foreign write) is INVALID', async () => {
		const handle = await bindQueue(client(), voided).add(to('a'), { id: 'a' });
		const [job] = (await claim(client(), queueKeys('voided'), 1, 30_000)).jobs;
		await complete(
			client(),
			queueKeys('voided'),
			voided,
			'a',
			job?.token ?? '',
			undefined,
			false,
		);
		expect(await handle.finished()).toBeUndefined();
		const required = await bindQueue(client(), sent).add(to('b'), { id: 'b' });
		const taken = await take();
		await complete(client(), keys, sent, 'b', taken.token, undefined, false);
		const error = (await rejection(required.finished())) as QueueError;
		expect(error.code).toBe('INVALID');
	});

	test('encodeResult stores nothing for undefined, and decodeResult runs the schema on it', () => {
		const optional = defineQueue({
			name: 'optional',
			schema: z.object({}),
			result: z.number().optional(),
		});
		expect(encodeResult(optional, undefined, 'optional')).toBeUndefined();
		expect(
			encodeResult(
				defineQueue({
					name: 'v',
					schema: z.object({}),
					result: z.void(),
				}),
				undefined,
				'v',
			),
		).toBeUndefined();
		let thrown: unknown;
		try {
			encodeResult(sent, undefined, 'sent');
		} catch (error) {
			thrown = error;
		}
		expect((thrown as QueueError).code).toBe('INVALID');
		expect((thrown as QueueError).message).not.toContain('undefined');
		expect(decodeResult(optional, undefined)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(decodeResult(sent, undefined)).toEqual({ ok: false });
	});
});

describe('encodeResult and decodeResult', () => {
	test('a queue without a result schema encodes and decodes nothing', () => {
		const plain = defineQueue({ name: 'plain', schema: z.object({}) });
		expect(encodeResult(plain, 5, 'plain')).toBeUndefined();
		expect(decodeResult(plain, undefined)).toEqual({
			ok: true,
			value: undefined,
		});
	});

	test('a result round-trips as JSON text, and one the schema refuses is INVALID', () => {
		expect(encodeResult(sent, { count: 2 }, 'sent')).toBe('{"count":2}');
		expect(decodeResult(sent, '{"count":2}')).toEqual({
			ok: true,
			value: { count: 2 },
		});
		expect(decodeResult(sent, '{"count":"x"}')).toEqual({ ok: false });
		expect(decodeResult(sent, 'not json')).toEqual({ ok: false });
		let thrown: unknown;
		try {
			encodeResult(sent, { count: 'secret' }, 'sent');
		} catch (error) {
			thrown = error;
		}
		expect((thrown as QueueError).code).toBe('INVALID');
		expect((thrown as QueueError).message).not.toContain('secret');
	});
});

/** A client whose `hmget`, or whose subscriber's PING, never answers. */
function hanging(what: 'read' | 'flush') {
	const never = new Promise<never>(() => undefined);
	const wrap = (real: RedisClient, hang: (prop: string | symbol) => boolean) =>
		new Proxy(real, {
			get(target, prop) {
				if (hang(prop)) return () => never;
				if (prop === 'duplicate' && what === 'flush') {
					return async () => {
						const subscriber = await target.duplicate();
						return new Proxy(subscriber, {
							get(inner, key) {
								if (key === 'send') {
									return (command: string, args: string[]) =>
										command === 'PING' ? never : inner.send(command, args);
								}
								const value = Reflect.get(inner, key, inner);
								return typeof value === 'function' ? value.bind(inner) : value;
							},
						});
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	return wrap(client(), (prop) => what === 'read' && prop === 'hmget');
}

describe('finished({ timeout }) is a hard bound', () => {
	test('finished({ timeout }) rejects on time even when the first read never answers', async () => {
		const before = await connections();
		const handle = jobHandle(hanging('read'), sent, keys, 'a', false);
		const started = Date.now();
		const error = (await rejection(
			handle.finished({ timeout: 200 }),
		)) as QueueError;
		expect(error.code).toBe('WAIT_TIMEOUT');
		expect(Date.now() - started).toBeLessThan(600);
		await eventually(connections, before);
	});

	test('finished({ timeout }) rejects on time even when the flush never answers', async () => {
		const before = await connections();
		const handle = jobHandle(hanging('flush'), sent, keys, 'absent', false);
		const started = Date.now();
		const error = (await rejection(
			handle.finished({ timeout: 200 }),
		)) as QueueError;
		expect(error.code).toBe('WAIT_TIMEOUT');
		expect(Date.now() - started).toBeLessThan(600);
		await eventually(connections, before);
	});
});

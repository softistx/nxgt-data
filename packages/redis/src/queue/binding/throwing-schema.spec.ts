import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { eventually, subscribed, useRedis } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { QueueError } from '../../errors/queue-error';
import { defineQueue } from '../definition/define-queue';
import { claim } from '../scripts/claim/claim';
import { complete } from '../scripts/settle';
import type { Worker } from '../worker/types';
import { bindQueue } from './bind-queue';
import { jobHandle } from './handle';
import { queueKeys } from './keys';

const servers = useRedis();
const client = () => servers.redis.client;

/**
 * A schema whose refine throws on `{n: 2}`: zod re-raises a throw from a
 * refine or a transform out of `safeParse`, so "never thrown" has to be made
 * true by the caller.
 */
const throwing = z.object({ n: z.number() }).refine((value) => {
	if (value.n === 2) throw new Error('refine blew up on secret');
	return true;
});

const results = defineQueue({
	name: 'throws',
	schema: z.object({ to: z.string() }),
	result: throwing,
	keepCompleted: false,
	backoff: { base: 10, max: 10 },
});
const payloads = defineQueue({
	name: 'throws',
	schema: throwing,
	backoff: { base: 10, max: 10 },
});
const keys = queueKeys('throws');
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

async function claimOne() {
	const [job] = (await claim(client(), keys, 1, 30_000, undefined)).jobs;
	if (!job) throw new Error('nothing to claim');
	return job;
}

/** The client, counting its HMGETs: the handle's reads. */
function countingReads() {
	let reads = 0;
	const real = client();
	const proxy = new Proxy(real, {
		get(target, prop) {
			if (prop === 'hmget') {
				return (...args: Parameters<typeof real.hmget>) => {
					reads++;
					return target.hmget(...args);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as RedisClient;
	return { client: proxy, reads: () => reads };
}

describe('a result schema that throws', () => {
	test('on the event path, finished rejects INVALID instead of hanging', async () => {
		await bindQueue(client(), results).add({ to: 'a' }, { id: 'a' });
		const job = await claimOne();
		const handle = jobHandle(client(), results, keys, 'a', false, 60_000);
		const waited = rejection(handle.finished({ timeout: 3000 }));
		await subscribed(client(), keys.events);
		await complete(client(), keys, results, 'a', job.token, '{"n":2}', false);
		const error = (await waited) as QueueError;
		expect(error).toBeInstanceOf(QueueError);
		expect(error.code).toBe('INVALID');
		expect(error.message).not.toContain('secret');
	});

	test('on the re-read path, finished rejects INVALID and nothing escapes', async () => {
		await bindQueue(client(), results).add({ to: 'a' }, { id: 'a' });
		const job = await claimOne();
		const spy = countingReads();
		const handle = jobHandle(spy.client, results, keys, 'a', false, 50);
		const waited = rejection(handle.finished({ timeout: 3000 }));
		// The first read found the job running; the event goes elsewhere, so
		// only a re-read can tell. keepCompleted is false, but the result is
		// kept by a definition that keeps it.
		await eventually(() => spy.reads() >= 1, true);
		await complete(
			client(),
			{ ...keys, events: 'queue:{throws}:elsewhere' },
			{ ...results, keepCompleted: { age: 60_000, count: 10 } },
			'a',
			job.token,
			'{"n":2}',
			false,
		);
		const error = (await waited) as QueueError;
		expect(error.code).toBe('INVALID');
	});

	test('on the first read, finished rejects INVALID, not the schema error', async () => {
		const kept = { ...results, keepCompleted: { age: 60_000, count: 10 } };
		await bindQueue(client(), results).add({ to: 'a' }, { id: 'a' });
		const job = await claimOne();
		await complete(client(), keys, kept, 'a', job.token, '{"n":2}', false);
		const handle = jobHandle(client(), results, keys, 'a', false);
		const error = (await rejection(handle.finished())) as QueueError;
		expect(error).toBeInstanceOf(QueueError);
		expect(error.code).toBe('INVALID');
	});

	test('in the worker, the job fails INVALID with no retry', async () => {
		let calls = 0;
		const worker: Worker = bindQueue(client(), results).work(() => {
			calls += 1;
			return { n: 2 };
		});
		try {
			const handle = await bindQueue(client(), {
				...results,
				keepCompleted: { age: 60_000, count: 10 },
			}).add({ to: 'a' }, { id: 'a' });
			const error = (await rejection(handle.finished())) as QueueError;
			expect(error.code).toBe('FAILED');
			expect(error.lastError).toEqual({
				name: 'QueueError',
				message: 'INVALID: the result does not match the result schema',
			});
			expect(calls).toBe(1);
		} finally {
			await worker.close();
		}
	});
});

describe('a payload schema that throws', () => {
	test('at add, the call rejects INVALID with no value in the message', async () => {
		const error = await rejection(
			bindQueue(client(), payloads).add({ n: 2 }, { id: 'a' }),
		);
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).message).not.toContain('secret');
		expect(await hget('a', 'state')).toBeNull();
	});

	test('at claim, the job fails INVALID with no retry and the handler never runs', async () => {
		// Added under a schema that accepts it, worked under one that throws.
		const lenient = { ...payloads, schema: z.object({ n: z.number() }) };
		await bindQueue(client(), lenient).add({ n: 2 }, { id: 'a' });
		let calls = 0;
		const worker = bindQueue(client(), payloads).work(() => {
			calls += 1;
		});
		try {
			await eventually(() => hget('a', 'state'), 'failed');
			expect(JSON.parse((await hget('a', 'error')) ?? 'null')).toEqual({
				name: 'QueueError',
				message: 'INVALID: the stored data does not match the schema',
			});
			expect(calls).toBe(0);
		} finally {
			await worker.close();
		}
	});
});

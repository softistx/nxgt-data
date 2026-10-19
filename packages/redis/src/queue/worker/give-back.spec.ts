import { afterEach, describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { z } from 'zod';
import { useRedis } from '../../../test/fixtures';
import { expectGroupState } from '../../../test/group-state';
import { bindQueue } from '../binding/bind-queue';
import { defineQueue } from '../definition/define-queue';
import { queueKeys } from '../keys';
import { RELEASE } from '../scripts/release';
import { COMPLETE } from '../scripts/settle';
import type { Worker } from './types';

const servers = useRedis();
const client = () => servers.redis.client;
const schema = z.object({ n: z.number() });
// A long lease and one attempt: a job left to lapse would fail, not wait.
const once = defineQueue({ name: 'once', schema, lease: 30_000, attempts: 1 });
const grouped = defineQueue({
	name: 'once',
	schema,
	lease: 30_000,
	attempts: 1,
	groups: { concurrency: 1 },
});
const keys = queueKeys('once');

const opened: Worker[] = [];
afterEach(async () => {
	for (const worker of opened.splice(0)) await worker.close();
});

/**
 * A client that calls `onComplete` as the first `COMPLETE` is sent, before
 * it reaches the server, and counts the `RELEASE`s sent.
 */
function spied(onComplete: () => void) {
	const real = client();
	const seen = { releases: 0, completes: 0 };
	const proxy = new Proxy(real, {
		get(target, prop) {
			if (prop === 'evalsha') {
				return (...args: Parameters<RedisClient['evalsha']>) => {
					if (args[0] === COMPLETE.sha && seen.completes++ === 0) onComplete();
					if (args[0] === RELEASE.sha) seen.releases++;
					return target.evalsha(...args);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { proxy, seen };
}

/**
 * Runs `a` and `b` on a worker of one slot that closes while a's COMPLETE,
 * which claims b, is in flight; answers what that worker ran and b's handle.
 */
async function closeDuringComplete(definition: typeof once) {
	let closing: Promise<void> | undefined;
	let worker: Worker | undefined;
	const { proxy, seen } = spied(() => {
		closing = worker?.close();
	});
	const queue = bindQueue(client(), definition);
	const group = definition.groups ? { group: 'A' } : {};
	await queue.add({ n: 1 }, { id: 'a', ...group });
	const b = await queue.add({ n: 2 }, { id: 'b', ...group });
	const ran: string[] = [];
	worker = bindQueue(proxy, definition).work(
		async (job) => {
			ran.push(job.id);
		},
		{ concurrency: 1 },
	);
	opened.push(worker);
	while (!closing) await Bun.sleep(5);
	await closing;
	return { ran, b, seen, queue };
}

describe('a worker closing while a claim is in flight', () => {
	test('gives back the job the claim took: waiting, attempt 0, then run', async () => {
		const { ran, b, seen, queue } = await closeDuringComplete(once);
		expect(ran).toEqual(['a']);
		expect(seen.releases).toBe(1);
		expect(await client().hget(keys.job('b'), 'state')).toBe('waiting');
		expect(await client().hget(keys.job('b'), 'attempt')).toBe('0');
		expect(await client().hget(keys.job('b'), 'token')).toBeNull();
		expect(await client().send('ZSCORE', [keys.active, 'b'])).toBeNull();
		expect(await client().send('ZSCORE', [keys.ready, 'b'])).not.toBeNull();
		const next: string[] = [];
		opened.push(queue.work(async (job) => void next.push(job.id)));
		expect(await b.finished()).toBeUndefined();
		expect(next).toEqual(['b']);
	});

	test('frees the group slot the claim took', async () => {
		const { ran, b, queue } = await closeDuringComplete(grouped);
		expect(ran).toEqual(['a']);
		expect(await client().hget(keys.job('b'), 'state')).toBe('waiting');
		expect(await client().hget(keys.job('b'), 'attempt')).toBe('0');
		expect(await client().get(`${keys.group}A:active`)).toBeNull();
		await expectGroupState(client(), keys, 1);
		opened.push(queue.work(() => undefined));
		expect(await b.finished()).toBeUndefined();
	});
});

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { eventually, gate, mailQueue, useRedis } from '../../../test/fixtures';
import { JobError } from '../../errors/job-error';
import { bindQueue } from '../binding/bind-queue';
import { defineQueue } from '../definition/define-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim/claim';
import type { Worker, WorkerEvents } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

const resultQueue = defineQueue({
	name: 'mails',
	schema: mailQueue.schema,
	result: z.object({ sent: z.number() }),
	lease: 300,
	backoff: { base: 10, max: 50 },
});

/** Runs `body` with a way to start workers that are always closed. */
async function withWorkers(body: (open: Opener) => Promise<void>) {
	const opened: Worker[] = [];
	const open: Opener = (handler, queue = mailQueue) => {
		const worker = bindQueue(client(), queue).work(handler as never);
		opened.push(worker);
		const seen: string[] = [];
		for (const event of [
			'active',
			'progress',
			'completed',
			'retrying',
			'failed',
			'stalled',
		] as const) {
			worker.on(event, (payload: WorkerEvents[typeof event]) => {
				seen.push(`${event} ${(payload as { id: string }).id}`);
			});
		}
		return { worker, seen };
	};
	try {
		await body(open);
	} finally {
		for (const worker of opened) await worker.close();
	}
}
type Opener = (
	handler: (job: {
		id: string;
		attempt: number;
		progress(value: number): Promise<void>;
	}) => unknown,
	queue?: typeof mailQueue | typeof resultQueue,
) => { worker: Worker; seen: string[] };

describe('results', () => {
	test('the result reaches finished and get', async () => {
		await withWorkers(async (open) => {
			open(() => ({ sent: 2 }), resultQueue);
			const handle = await bindQueue(client(), resultQueue).add(
				{ to: 'a' },
				{ id: 'a' },
			);
			expect(await handle.finished()).toEqual({ sent: 2 });
			expect(await hget('a', 'result')).toBe('{"sent":2}');
			const view = await bindQueue(client(), resultQueue).get('a');
			expect(view?.result).toEqual({ sent: 2 });
		});
	});

	test('a result the schema refuses fails the job INVALID without retry', async () => {
		await withWorkers(async (open) => {
			let calls = 0;
			open(() => {
				calls += 1;
				return { sent: 'many' };
			}, resultQueue);
			await bindQueue(client(), resultQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'failed');
			expect(calls).toBe(1);
			expect(JSON.parse((await hget('a', 'error')) ?? 'null')).toEqual({
				name: 'QueueError',
				message: 'INVALID: the result does not match the result schema',
			});
		});
	});
});

describe('progress', () => {
	test('is stored and emitted, and refused out of range', async () => {
		await withWorkers(async (open) => {
			const refused: unknown[] = [];
			const { seen } = open(async (job) => {
				await job.progress(40);
				for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
					await job.progress(bad).catch((e: unknown) => void refused.push(e));
				}
				expect(await hget(job.id, 'progress')).toBe('40');
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'completed');
			expect(seen).toContain('progress a');
			expect(refused).toHaveLength(4);
			expect((refused[0] as Error).message).toBe(
				'progress on "mails": progress is a number from 0 to 100',
			);
			expect(refused[0]).toBeInstanceOf(TypeError);
		});
	});
	test('a progress the token refuses emits nothing', async () => {
		await withWorkers(async (open) => {
			const { seen } = open(async (job) => {
				await client().send('HDEL', [keys.job(job.id), 'token']);
				await job.progress(10);
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => seen.includes('active a'), true);
			await Bun.sleep(100);
			expect(seen.filter((e) => e.startsWith('progress'))).toEqual([]);
			expect(await hget('a', 'progress')).toBeNull();
		});
	});
});

describe('events', () => {
	test('arrive in order: active, completed', async () => {
		await withWorkers(async (open) => {
			const { worker, seen } = open(() => undefined);
			let duration = -1;
			worker.on('completed', (p) => {
				duration = p.duration;
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => seen, ['active a', 'completed a']);
			expect(duration).toBeGreaterThanOrEqual(0);
			await bindQueue(client(), mailQueue).add({ to: 'b' }, { id: 'b' });
			await eventually(
				() => seen,
				['active a', 'completed a', 'active b', 'completed b'],
			);
		});
	});

	test('a retry emits retrying with its delay, the last attempt failed', async () => {
		await withWorkers(async (open) => {
			const { worker, seen } = open((job) => {
				throw new JobError(`no ${job.attempt}`, { retryIn: 20 });
			});
			const delays: number[] = [];
			worker.on('retrying', (p) => void delays.push(p.delay));
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => seen.at(-1), 'failed a');
			expect(delays).toEqual([20, 20]);
			expect(seen.filter((s) => s.startsWith('retrying'))).toHaveLength(2);
		});
	});

	test('a reclaimed lease emits stalled', async () => {
		await withWorkers(async (open) => {
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			// A worker that died: it claimed and never settled.
			await claim(client(), keys, 1, 300, undefined);
			await eventually(
				async () =>
					Number(await client().send('ZSCORE', [keys.active, 'a'])) <
					Date.now(),
				true,
			);
			const { seen } = open(() => undefined);
			await eventually(() => seen.includes('stalled a'), true);
			await eventually(() => hget('a', 'state'), 'completed');
		});
	});

	test('a throwing listener is reported on error and the loop carries on', async () => {
		await withWorkers(async (open) => {
			const { worker } = open(() => undefined);
			const errors: string[] = [];
			worker.on('error', (e) => void errors.push((e as Error).message));
			worker.on('active', () => {
				throw new Error('bad listener');
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await bindQueue(client(), mailQueue).add({ to: 'b' }, { id: 'b' });
			await eventually(() => hget('b', 'state'), 'completed');
			expect(errors).toContain('bad listener');
		});
	});
	test('a settle whose token is gone emits no completed or failed', async () => {
		await withWorkers(async (open) => {
			const { seen } = open(async (job) => {
				await client().send('HDEL', [keys.job(job.id), 'token']);
				if (job.id === 'b') throw new JobError('no', { retry: false });
			});
			const queue = bindQueue(client(), mailQueue);
			await queue.add({ to: 'a' }, { id: 'a' });
			await queue.add({ to: 'b' }, { id: 'b' });
			await eventually(() => seen.length, 2);
			await Bun.sleep(100);
			expect(seen).toEqual(['active a', 'active b']);
		});
	});

	test('a job the claim found unreadable reaches failed with attempt 0', async () => {
		await withWorkers(async (open) => {
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await client().send('HSET', [keys.job('a'), 'attempts', 'junk']);
			const { worker } = open(() => undefined);
			const failed: WorkerEvents['failed'][] = [];
			worker.on('failed', (p) => void failed.push(p));
			await eventually(() => failed.length, 1);
			expect(failed[0]).toEqual({
				id: 'a',
				attempt: 0,
				error: {
					name: 'QueueError',
					message: 'INVALID: a stored job this package could not have written',
				},
			});
			// The event says what the hash holds, word for word.
			const stored = await client().hget(keys.job('a'), 'error');
			expect(failed[0]?.error).toEqual(JSON.parse(stored ?? 'null'));
		});
	});
});

describe('idle', () => {
	test('resolves once every added job is done, and at once on an idle worker', async () => {
		await withWorkers(async (open) => {
			const done: string[] = [];
			const { worker } = open(async (job) => {
				await Bun.sleep(20);
				done.push(job.id);
			});
			await worker.idle(); // before the first claim: waits for it
			const queue = bindQueue(client(), mailQueue);
			await queue.addMany([
				{ data: { to: 'a' }, options: { id: 'a' } },
				{ data: { to: 'b' }, options: { id: 'b' } },
				{ data: { to: 'c' }, options: { id: 'c' } },
			]);
			await Promise.all([worker.idle(), worker.idle()]);
			expect(done.sort()).toEqual(['a', 'b', 'c']);
			const at = performance.now();
			await worker.idle();
			expect(performance.now() - at).toBeLessThan(50);
		});
	});

	test('waits for a job claimed after it was first idle', async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			let finished = false;
			const { worker } = open(async () => {
				await hold.opened;
				finished = true;
			});
			await worker.idle();
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			const idle = worker.idle().then(() => finished);
			// Claimed and running: idle is now waiting on that slot.
			await eventually(() => hget('a', 'state'), 'active');
			hold.open();
			expect(await idle).toBe(true);
		});
	});
	test('after close resolves', async () => {
		await withWorkers(async (open) => {
			const { worker } = open(() => undefined);
			await worker.close();
			await worker.idle();
		});
	});

	test('never polls: its checks do not grow while it waits', async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			const { worker } = open(async () => {
				await hold.opened;
			});
			await worker.idle();
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'active');
			const zcards = async () =>
				Number(
					(await client().info('commandstats')).match(
						/cmdstat_zcard:calls=(\d+)/,
					)?.[1] ?? 0,
				);
			const idle = worker.idle();
			await Bun.sleep(50);
			const early = await zcards();
			await Bun.sleep(300);
			expect(await zcards()).toBe(early);
			hold.open();
			await idle;
		});
	});
});

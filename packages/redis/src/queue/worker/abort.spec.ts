import { describe, expect, test } from 'bun:test';
import {
	eventually,
	gate,
	mailQueue,
	subscribed as subscribedTo,
	useRedis,
} from '../../../test/fixtures';
import { QueueError } from '../../errors/queue-error';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { flush } from '../events/subscriber';
import { queueKeys } from '../keys';
import {
	abortAll,
	abortLost,
	abortRun,
	armTimeout,
	beginRun,
	endRun,
	hearCancels,
} from './abort';
import type { WorkerContext } from './context';
import type { JobContext, Worker, WorkerEvents } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const hget = (id: string, field: string) => client().hget(keys.job(id), field);
const schema = mailQueue.schema;

const timed = defineQueue({
	name: 'mails',
	schema,
	lease: 300,
	attempts: 3,
	timeout: 100,
	backoff: { base: 10, max: 50 },
});
const once = defineQueue({
	name: 'mails',
	schema,
	lease: 300,
	attempts: 1,
	timeout: 100,
});
const slow = defineQueue({
	name: 'mails',
	schema,
	lease: '30s',
	backoff: { base: 10, max: 50 },
});

type Handler = (job: JobContext<typeof schema>) => unknown;

/** Runs `body` with a way to start workers that are always closed. */
async function withWorkers(
	body: (
		open: (handler: Handler, queue?: typeof timed) => Opened,
	) => Promise<void>,
) {
	const workers: Worker[] = [];
	const open = (
		handler: Handler,
		queue = mailQueue as typeof timed,
	): Opened => {
		const worker = bindQueue(client(), queue).work(handler as never);
		workers.push(worker);
		const seen: string[] = [];
		const errors: unknown[] = [];
		for (const event of [
			'completed',
			'retrying',
			'failed',
			'canceled',
		] as const) {
			worker.on(event, (p: WorkerEvents[typeof event]) => {
				seen.push(`${event} ${(p as { id: string }).id}`);
			});
		}
		worker.on('error', (e) => void errors.push(e));
		return { worker, seen, errors };
	};
	try {
		await body(open);
	} finally {
		for (const worker of workers) await worker.close({ grace: 100 });
	}
}
type Opened = { worker: Worker; seen: string[]; errors: unknown[] };

/** Resolves once a worker's SUBSCRIBE to the queue's events is live. */
const subscribed = () => subscribedTo(client(), keys.events);

/** Resolves with the signal's reason when it aborts. */
function abortReason(signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve(signal.reason);
		signal.addEventListener('abort', () => resolve(signal.reason), {
			once: true,
		});
	});
}

describe('the run registry', () => {
	const job = (token: string, timeout?: number) => ({
		id: 'a',
		data: '{}',
		attempt: 1,
		attempts: 3,
		token,
		timeout,
	});
	const registry = () =>
		({ runs: new Map(), definition: mailQueue }) as unknown as WorkerContext;

	test('two runs of one id are both held: the first still times out, abortAll reaches both, endRun is by token', async () => {
		const context = registry();
		const first = beginRun(context, job('t1', 30));
		const second = beginRun(context, job('t2'));
		armTimeout(context, job('t1', 30));
		await eventually(() => first.controller.signal.aborted, true);
		expect((first.controller.signal.reason as QueueError).code).toBe('TIMEOUT');
		expect(second.controller.signal.aborted).toBe(false);

		const third = beginRun(context, job('t3'));
		abortAll(context);
		expect((second.controller.signal.reason as QueueError).code).toBe('CLOSED');
		expect(third.controller.signal.aborted).toBe(true);

		endRun(context, job('t1'));
		expect(context.runs.get('a')?.size).toBe(2);
		endRun(context, job('t2'));
		endRun(context, job('t3'));
		expect(context.runs.size).toBe(0);
	});

	test('a cancel event aborts only the run whose token it names; one with no token aborts nothing', async () => {
		const context = {
			runs: new Map(),
			definition: mailQueue,
			client: client(),
			keys,
		} as unknown as WorkerContext;
		const first = beginRun(context, job('t1'));
		const second = beginRun(context, job('t2'));
		const stop = await hearCancels(context);
		try {
			const publish = async (message: object) => {
				await client().publish(keys.events, JSON.stringify(message));
				// Every message published before the PING reply has been heard.
				await flush(client());
			};
			// A waiting or delayed job's cancel: nothing ran, nothing is aborted.
			await publish({ type: 'canceled', id: 'a' });
			expect(first.controller.signal.aborted).toBe(false);
			expect(second.controller.signal.aborted).toBe(false);
			// The run claimed after the cancel (t2) keeps going.
			await publish({ type: 'canceled', id: 'a', token: 't1' });
			expect((first.controller.signal.reason as QueueError).code).toBe(
				'CANCELED',
			);
			expect(second.controller.signal.aborted).toBe(false);
		} finally {
			await stop();
		}
	});

	test('a lost lease and a cancel match by token and by id', () => {
		const context = registry();
		const first = beginRun(context, job('t1'));
		const second = beginRun(context, job('t2'));
		abortLost(context, [{ id: 'a', token: 't2' }]);
		expect(first.controller.signal.aborted).toBe(false);
		expect((second.controller.signal.reason as QueueError).code).toBe(
			'LEASE_LOST',
		);
		expect(abortRun(context, 'CANCELED', 'a')).toBe(true);
		expect((first.controller.signal.reason as QueueError).code).toBe(
			'CANCELED',
		);
	});
});

describe('abort', () => {
	test('a handler past its timeout is aborted, recorded TIMEOUT once, and retried', async () => {
		await withWorkers(async (open) => {
			const late = gate();
			const reasons: unknown[] = [];
			const attempts: number[] = [];
			const { seen } = open((job) => {
				attempts.push(job.attempt);
				if (job.attempt === 1) {
					void abortReason(job.signal).then((r) => reasons.push(r));
					return late.opened; // ignores the signal, returns late
				}
				return undefined;
			}, timed);
			await bindQueue(client(), timed).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'completed');
			expect(attempts).toEqual([1, 2]);
			expect(seen.filter((s) => s.startsWith('retrying'))).toEqual([
				'retrying a',
			]);
			const reason = reasons[0] as QueueError;
			expect(reason).toBeInstanceOf(QueueError);
			expect(reason.code).toBe('TIMEOUT');
			expect(reason.message).toContain('"mails"');
			expect(reason.message).toContain('"a"');
			late.open(); // the abandoned handler returns: refused, never a COMPLETE
			await Bun.sleep(100);
			expect(seen.filter((s) => s.startsWith('completed'))).toEqual([
				'completed a',
			]);
			expect(await hget('a', 'attempt')).toBe('2');
		});
	});

	test('the timeout is recorded as the attempt error', async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			open(() => hold.opened, once as unknown as typeof timed);
			await bindQueue(client(), once).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'failed');
			expect(JSON.parse((await hget('a', 'error')) ?? 'null')).toEqual({
				name: 'TIMEOUT',
				message: 'the attempt ran past its timeout',
			});
			hold.open();
		});
	});

	test('cancel aborts a running job at once, through the event', async () => {
		await withWorkers(async (open) => {
			const started = gate();
			const hold = gate();
			let signal: AbortSignal | undefined;
			const { seen } = open((job) => {
				signal = job.signal;
				started.open();
				return hold.opened;
			}, slow);
			await subscribed();
			await bindQueue(client(), slow).add({ to: 'a' }, { id: 'a' });
			await started.opened;
			const at = Date.now();
			expect(await bindQueue(client(), slow).cancel('a')).toBe(true);
			const reason = (await Promise.race([
				abortReason(signal as AbortSignal),
				Bun.sleep(2_000).then(() => 'late'),
			])) as QueueError;
			expect(Date.now() - at).toBeLessThan(200);
			expect(reason.code).toBe('CANCELED');
			await eventually(() => seen.includes('canceled a'), true);
			hold.open();
		});
	});

	test('a lost lease aborts with LEASE_LOST and frees the slot', async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			const reasons: unknown[] = [];
			const ran: string[] = [];
			const { errors } = open((job) => {
				ran.push(job.id);
				if (job.id === 'a') {
					void abortReason(job.signal).then((r) => reasons.push(r));
					return hold.opened;
				}
				return undefined;
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => ran, ['a']);
			await client().send('HDEL', [keys.job('a'), 'token']); // taken away by hand
			await eventually(() => reasons.length, 1);
			expect((reasons[0] as QueueError).code).toBe('LEASE_LOST');
			expect((errors[0] as QueueError).code).toBe('LEASE_LOST');
			// The slot is free while a's handler still runs.
			await bindQueue(client(), mailQueue).add({ to: 'b' }, { id: 'b' });
			await eventually(() => hget('b', 'state'), 'completed');
			hold.open();
		});
	});

	test('close waits for a running job within grace', async () => {
		await withWorkers(async (open) => {
			const started = gate();
			const { worker } = open(async () => {
				started.open();
				await Bun.sleep(150);
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await started.opened;
			await worker.close({ grace: 5_000 });
			expect(await hget('a', 'state')).toBe('completed');
		});
	});

	test('close aborts a handler that outlives grace, and resolves within grace', async () => {
		await withWorkers(async (open) => {
			const started = gate();
			const hold = gate();
			let signal: AbortSignal | undefined;
			const { worker, seen } = open((job) => {
				signal = job.signal;
				started.open();
				return hold.opened; // ignores the signal
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await started.opened;
			const at = Date.now();
			await worker.close({ grace: 200 });
			const took = Date.now() - at;
			expect(took).toBeGreaterThanOrEqual(190);
			expect(took).toBeLessThan(600);
			expect((signal as AbortSignal).reason.code).toBe('CLOSED');
			expect(seen).toEqual([]); // CLOSED emits nothing
			expect(await hget('a', 'state')).toBe('active');
			// Nobody renews it: once the lease lapsed, another worker reclaims it.
			await eventually(
				async () =>
					Number(await client().send('ZSCORE', [keys.active, 'a'])) <
					Date.now(),
				true,
			);
			const second = open(() => undefined);
			await eventually(() => hget('a', 'state'), 'completed');
			expect(second.seen).toEqual(['completed a']);
			expect(await hget('a', 'attempt')).toBe('2');
			hold.open();
		});
	});

	test('close with a malformed grace is refused without naming the value', async () => {
		await withWorkers(async (open) => {
			const { worker } = open(() => undefined);
			const refused = await worker.close({ grace: -5 }).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(refused).toBeInstanceOf(TypeError);
			expect((refused as Error).message).toContain('close on "mails"');
			expect((refused as Error).message).not.toContain('-5');
		});
	});

	test('a second close gets the first promise, and its grace is neither read nor checked', async () => {
		await withWorkers(async (open) => {
			const { worker } = open(() => undefined);
			const first = worker.close({ grace: 100 });
			const second = worker.close({ grace: -5 });
			expect(second).toBe(first);
			await second;
		});
	});

	test("the per-job timeout of add wins over the definition's", async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			const reasons: Record<string, unknown> = {};
			open(
				(job) => {
					void abortReason(job.signal).then((r) => {
						reasons[job.id] = r;
					});
					return hold.opened;
				},
				{ ...timed, timeout: 60_000 } as typeof timed,
			);
			const queue = bindQueue(client(), {
				...timed,
				timeout: 60_000,
			} as typeof timed);
			await queue.add({ to: 'a' }, { id: 'a', timeout: 100 });
			await eventually(
				() => (reasons['a'] as QueueError | undefined)?.code,
				'TIMEOUT',
			);
			hold.open();
		});
	});

	test("a longer per-job timeout than the definition's is not cut short", async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			const reasons: unknown[] = [];
			const started = gate();
			open((job) => {
				void abortReason(job.signal).then((r) => reasons.push(r));
				started.open();
				return hold.opened;
			}, timed);
			await bindQueue(client(), timed).add(
				{ to: 'b' },
				{ id: 'b', timeout: '30s' },
			);
			await started.opened;
			await Bun.sleep(300); // three times the definition's timeout
			expect(reasons).toEqual([]);
			hold.open();
		});
	});

	test('concurrency counts only jobs not yet aborted', async () => {
		await withWorkers(async (open) => {
			const hold = gate();
			const ran: string[] = [];
			open((job) => {
				ran.push(job.id);
				if (job.id === 'a') return hold.opened; // ignores its signal
				return undefined;
			}, slow);
			await subscribed();
			await bindQueue(client(), slow).add({ to: 'a' }, { id: 'a' });
			await eventually(() => ran, ['a']);
			await bindQueue(client(), slow).add({ to: 'b' }, { id: 'b' });
			await Bun.sleep(100);
			expect(ran).toEqual(['a']); // concurrency 1: b waits
			await bindQueue(client(), slow).cancel('a');
			await eventually(() => hget('b', 'state'), 'completed');
			hold.open();
		});
	});

	test('a progress after close cut the handler off is neither stored nor emitted', async () => {
		await withWorkers(async (open) => {
			const started = gate();
			const hold = gate();
			let report: ((value: number) => Promise<void>) | undefined;
			const { worker } = open((job) => {
				report = job.progress;
				started.open();
				return hold.opened;
			});
			const progressed: unknown[] = [];
			worker.on('progress', (p) => void progressed.push(p));
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await started.opened;
			await worker.close({ grace: 50 });
			await (report as (value: number) => Promise<void>)(50);
			await Bun.sleep(50); // an emit would be synchronous after the store: a short wait is enough
			expect(progressed).toEqual([]);
			expect(await hget('a', 'progress')).toBeNull();
			hold.open();
		});
	});
});

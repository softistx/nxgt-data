import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
	eventually,
	gate,
	mailQueue,
	scriptCalls,
	subscribed as subscribedTo,
	useRedis,
} from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { QueueError } from '../../errors/queue-error';
import { bindQueue } from '../bind-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
import type { ClaimedJob } from '../scripts/replies';
import { abortRun, beginRun, endRun } from './abort';
import type { WorkerContext } from './context';
import { stepsOf } from './steps';
import type { JobContext, Worker, WorkerEvents } from './types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const hget = (id: string, field: string) => client().hget(keys.job(id), field);

type Handler = (job: JobContext<typeof mailQueue.schema>) => unknown;

/** Runs `body` with a way to start workers that are always closed. */
async function withWorkers(
	body: (open: (handler: Handler) => Opened) => Promise<void>,
) {
	const workers: Worker[] = [];
	const open = (handler: Handler): Opened => {
		const worker = bindQueue(client(), mailQueue).work(handler as never);
		workers.push(worker);
		const seen: string[] = [];
		const failures: { name: string; message: string }[] = [];
		const errors: unknown[] = [];
		worker.on('error', (e) => void errors.push(e));
		for (const event of ['completed', 'retrying', 'failed'] as const) {
			worker.on(event, (p: WorkerEvents[typeof event]) => {
				seen.push(`${event} ${(p as { id: string }).id}`);
				if (event === 'failed') {
					failures.push((p as WorkerEvents['failed']).error);
				}
			});
		}
		return { seen, failures, errors };
	};
	try {
		await body(open);
	} finally {
		for (const worker of workers) await worker.close({ grace: 100 });
	}
}
type Opened = {
	seen: string[];
	failures: { name: string; message: string }[];
	errors: unknown[];
};

const once = {
	...mailQueue,
	attempts: 1,
} as typeof mailQueue;

/** An attempt held by hand: claimed, registered, and with no lease renewals, so it can lapse. */
async function hold(id = 'a', over?: Partial<WorkerContext>) {
	await bindQueue(client(), mailQueue).add({ to: 'a' }, { id });
	return await take(handContext(over));
}
/** One context and runs map, so two attempts of an id are registered side by side as in a worker. */
function handContext(over?: Partial<WorkerContext>) {
	return {
		client: client(),
		definition: mailQueue,
		keys,
		runs: new Map(),
		...over,
	} as unknown as WorkerContext;
}
async function take(context: WorkerContext) {
	const reply = await claim(client(), keys, 1, mailQueue.lease);
	return attempt(reply.jobs[0] as ClaimedJob, context);
}
function attempt(job: ClaimedJob, context: WorkerContext) {
	const run = beginRun(context, job);
	const signal = run.controller.signal;
	return { job, context, signal, steps: stepsOf(context, job, signal) };
}
const lapsed = (id: string) =>
	eventually(
		async () =>
			Number(await client().send('ZSCORE', [keys.active, id])) < Date.now(),
		true,
	);
const codeOf = (error: unknown) => (error as QueueError).code;

describe('job.step in a worker', () => {
	test('a step runs once per job: the retry gets the stored value and fn is not called', async () => {
		await withWorkers(async (open) => {
			let calls = 0;
			const values: unknown[] = [];
			const { seen } = open(async (job) => {
				values.push(
					await job.step('send', () => {
						calls++;
						return { sent: true };
					}),
				);
				if (job.attempt === 1) throw new Error('boom');
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'completed');
			expect(calls).toBe(1);
			expect(values).toEqual([{ sent: true }, { sent: true }]);
			expect(seen).toContain('retrying a');
		});
	});

	test('a step returning undefined is not run again on retry', async () => {
		await withWorkers(async (open) => {
			let calls = 0;
			const values: unknown[] = [];
			open(async (job) => {
				values.push(
					await job.step('send', () => {
						calls++;
					}),
				);
				if (job.attempt === 1) throw new Error('boom');
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'completed');
			expect(calls).toBe(1);
			expect(values).toEqual([undefined, undefined]);
		});
	});

	test('retry(id) after a failure at step 3 resumes at step 3', async () => {
		await withWorkers(async () => {
			const calls = { s1: 0, s2: 0, s3: 0 };
			let broken = true;
			const queue = bindQueue(client(), once);
			const worker = queue.work((async (job: JobContext<never>) => {
				await job.step('s1', () => ++calls.s1);
				await job.step('s2', () => ++calls.s2);
				await job.step('s3', () => {
					calls.s3++;
					if (broken) throw new Error('boom');
				});
			}) as never);
			try {
				await queue.add({ to: 'a' }, { id: 'a' });
				await eventually(() => hget('a', 'state'), 'failed');
				broken = false;
				await queue.retry('a');
				await eventually(() => hget('a', 'state'), 'completed');
				expect(calls).toEqual({ s1: 1, s2: 1, s3: 2 });
			} finally {
				await worker.close({ grace: 100 });
			}
		});
	});

	test('a step value the schema refuses on read fails the job INVALID without retry', async () => {
		await withWorkers(async (open) => {
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await client().send('HSET', [keys.job('a'), 'step:send', '"foreign"']);
			let ran = false;
			const { seen, failures } = open(async (job) => {
				await job.step(
					'send',
					() => {
						ran = true;
						return 1;
					},
					{ schema: z.number() },
				);
			});
			await eventually(() => hget('a', 'state'), 'failed');
			expect(ran).toBe(false);
			expect(seen).toEqual(['failed a']);
			expect(failures[0]?.name).toBe('QueueError');
			expect(failures[0]?.message).toBe(
				'INVALID: step on "mails": step "send" holds a value the schema refuses',
			);
		});
	});

	test('a value fn returns that the JSON round trip would change fails the job INVALID without retry', async () => {
		await withWorkers(async (open) => {
			const { seen, failures } = open(async (job) => {
				await job.step('send', () => new Date());
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'failed');
			expect(seen).toEqual(['failed a']);
			expect(failures[0]?.name).toBe('QueueError');
			expect(failures[0]?.message).toStartWith(
				'INVALID: step on "mails": step "send" returned a value',
			);
			expect(await hget('a', 'step:send')).toBeNull();
		});
	});

	test('job.key is stable across attempts', async () => {
		await withWorkers(async (open) => {
			const seen: string[] = [];
			open(async (job) => {
				seen.push(job.key('send'));
				if (job.attempt === 1) throw new Error('boom');
			});
			await bindQueue(client(), mailQueue).add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'completed');
			expect(seen).toEqual(['mails:a:send', 'mails:a:send']);
		});
	});
});

describe('job.step by hand', () => {
	test('a step with a schema returns its output, stored as the output', async () => {
		const { steps } = await hold();
		const schema = z.object({ n: z.coerce.number() });
		const value = await steps.step('count', () => ({ n: '7' as never }), {
			schema,
		});
		expect(value).toEqual({ n: 7 });
		expect(await hget('a', 'step:count')).toBe('{"n":7}');
	});

	test('a stale attempt whose lease lapsed gets LEASE_LOST from step and fn does not run', async () => {
		const stale = await hold();
		await lapsed('a');
		const live = await take(stale.context);
		expect(live.job.token).not.toBe(stale.job.token);
		await live.steps.step('send', () => 'two');
		let ran = false;
		const error = await rejection(
			stale.steps.step('send', () => {
				ran = true;
				return 'one';
			}),
		);
		expect(codeOf(error)).toBe('LEASE_LOST');
		expect(ran).toBe(false);
		expect(codeOf(stale.signal.reason)).toBe('LEASE_LOST');
		// Same context and runs map: aborting by token never touched the live run.
		expect(stale.context).toBe(live.context);
		expect(live.signal.aborted).toBe(false);
		expect(await hget('a', 'step:send')).toBe('"two"');
	});

	test("a stale COMMIT is refused: the live attempt's value is the one stored", async () => {
		const stale = await hold();
		const started = gate();
		const release = gate();
		const late = rejection(
			stale.steps.step('send', async () => {
				started.open();
				await release.opened;
				return 'one';
			}),
		);
		await started.opened;
		await lapsed('a');
		const live = await take(stale.context);
		expect(await live.steps.step('send', () => 'two')).toBe('two');
		release.open();
		expect(codeOf(await late)).toBe('LEASE_LOST');
		expect(codeOf(stale.signal.reason)).toBe('LEASE_LOST');
		expect(await hget('a', 'step:send')).toBe('"two"');
	});

	test.each(['CLOSED', 'TIMEOUT'] as const)(
		'a run aborted with %s while fn runs still commits its value, and the step rejects with the reason',
		async (code) => {
			const { steps, context, job, signal } = await hold();
			const started = gate();
			const release = gate();
			const pending = rejection(
				steps.step('send', async () => {
					started.open();
					await release.opened;
					return 'one';
				}),
			);
			await started.opened;
			abortRun(context, code, job.id, job.token);
			release.open();
			const error = await pending;
			expect(error).toBe(signal.reason);
			expect(codeOf(error)).toBe(code);
			expect(await hget('a', 'step:send')).toBe('"one"');
		},
	);

	test('the same name twice in one attempt is a TypeError before any round trip', async () => {
		const { steps } = await hold();
		await steps.step('send', () => 1);
		const before = await scriptCalls(client());
		const error = await rejection(steps.step('send', () => 2));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'step on "mails": step "send" already ran in this attempt',
		);
		expect(await scriptCalls(client())).toBe(before);
	});

	test('a bad name is a TypeError for step and for key', async () => {
		const { steps } = await hold();
		const before = await scriptCalls(client());
		for (const name of ['', 'a:b', 'x'.repeat(129), 1 as never]) {
			expect(await rejection(steps.step(name, () => 1))).toBeInstanceOf(
				TypeError,
			);
			expect(() => steps.key(name)).toThrow(TypeError);
		}
		expect(() => steps.key('a:b')).toThrow('key on "mails"');
		expect(await scriptCalls(client())).toBe(before);
	});

	test('two different steps run concurrently', async () => {
		const { steps } = await hold();
		const open = gate();
		const values = await Promise.all([
			steps.step('first', async () => {
				await open.opened; // deadlocks unless the second started meanwhile
				return 1;
			}),
			steps.step('second', () => {
				open.open();
				return 2;
			}),
		]);
		expect(values).toEqual([1, 2]);
	});

	test("step after the signal aborted rejects with the signal's reason and costs no round trip", async () => {
		const { steps, context, job, signal } = await hold();
		abortRun(context, 'CANCELED', job.id, job.token);
		const before = await scriptCalls(client());
		const error = await rejection(steps.step('send', () => 1));
		expect(error).toBe(signal.reason);
		expect(codeOf(error)).toBe('CANCELED');
		expect(await scriptCalls(client())).toBe(before);
	});

	test('a step that runs costs two scripts, a stored one costs one', async () => {
		const first = await hold();
		let before = await scriptCalls(client());
		await first.steps.step('send', () => 1);
		expect((await scriptCalls(client())) - before).toBe(2);
		// A second attempt object over the same claim: its names are its own.
		const again = attempt(first.job, first.context);
		before = await scriptCalls(client());
		let ran = false;
		expect(
			await again.steps.step('send', () => {
				ran = true;
				return 2;
			}),
		).toBe(1);
		expect((await scriptCalls(client())) - before).toBe(1);
		expect(ran).toBe(false);
	});

	test('an abort while BEGIN is in flight stops fn from running', async () => {
		const begin = gate();
		const reply = gate();
		let delay = false;
		const real = client();
		// Overrides only evalsha/eval, which runScript calls: a changed call path times out, never falsely passes.
		const proxy = {
			evalsha: async (...args: unknown[]) => {
				if (delay) {
					delay = false;
					begin.open();
					await reply.opened;
				}
				return await (real.evalsha as (...a: unknown[]) => unknown)(...args);
			},
			eval: (...args: unknown[]) =>
				(real.eval as (...a: unknown[]) => unknown)(...args),
		} as unknown as WorkerContext['client'];
		const { steps, context, job } = await hold('a', { client: proxy });
		delay = true;
		let ran = false;
		const pending = rejection(
			steps.step('send', () => {
				ran = true;
				return 1;
			}),
		);
		await begin.opened;
		abortRun(context, 'CANCELED', job.id, job.token);
		reply.open();
		expect(codeOf(await pending)).toBe('CANCELED');
		expect(ran).toBe(false);
		expect(await hget('a', 'step:send')).toBeNull();
	});

	test('a step fired after the run ended rejects with a LEASE_LOST of its own, never undefined', async () => {
		const { steps, context, job } = await hold();
		endRun(context, job);
		await client().send('HDEL', [keys.job('a'), 'token']);
		const error = await rejection(steps.step('send', () => 1));
		expect(error).toBeInstanceOf(QueueError);
		expect(codeOf(error)).toBe('LEASE_LOST');
		expect((error as QueueError).job).toBe('a');
	});

	test('the INVALID of a refused value carries the job id', async () => {
		const { steps } = await hold();
		const error = await rejection(steps.step('send', () => new Date()));
		expect(codeOf(error)).toBe('INVALID');
		expect((error as QueueError).job).toBe('a');
		await client().send('HSET', [keys.job('a'), 'step:read', '"x"']);
		const read = await rejection(
			steps.step('read', () => 1, { schema: z.number() }),
		);
		expect((read as QueueError).job).toBe('a');
	});

	test('a throw from fn propagates and records nothing', async () => {
		const { steps } = await hold();
		const error = await rejection(
			steps.step('send', () => {
				throw new Error('boom');
			}),
		);
		expect((error as Error).message).toBe('boom');
		expect(await hget('a', 'step:send')).toBeNull();
	});
});

describe('job.step end to end', () => {
	test('a lease taken from under the run: step rejects LEASE_LOST, error is emitted, fn does not run, the slot is freed', async () => {
		await withWorkers(async (open) => {
			let ran = false;
			let rejected: unknown;
			const { seen, errors } = open(async (job) => {
				if (job.id !== 'a') return;
				// The lease is gone: another worker would hold the job under a new token.
				await client().send('HSET', [keys.job('a'), 'token', 'other']);
				rejected = await rejection(
					job.step('send', () => {
						ran = true;
						return 1;
					}),
				);
			});
			const queue = bindQueue(client(), mailQueue);
			await queue.add({ to: 'a' }, { id: 'a' });
			await queue.add({ to: 'b' }, { id: 'b' });
			await eventually(() => hget('b', 'state'), 'completed');
			expect(codeOf(rejected)).toBe('LEASE_LOST');
			expect(ran).toBe(false);
			expect(errors.map(codeOf)).toContain('LEASE_LOST');
			expect(seen).toContain('completed b');
		});
	});

	test('queue.cancel(id) aborts the run, and a step called then rejects CANCELED without running fn', async () => {
		await withWorkers(async (open) => {
			const aborted = gate();
			const done = gate();
			let rejected: unknown;
			let ran = false;
			open(async (job) => {
				job.signal.addEventListener('abort', () => aborted.open(), {
					once: true,
				});
				if (job.signal.aborted) aborted.open();
				await aborted.opened;
				rejected = await rejection(
					job.step('send', () => {
						ran = true;
						return 1;
					}),
				);
				done.open();
			});
			await subscribedTo(client(), keys.events);
			const queue = bindQueue(client(), mailQueue);
			await queue.add({ to: 'a' }, { id: 'a' });
			await eventually(() => hget('a', 'state'), 'active');
			expect(await queue.cancel('a')).toBe(true);
			await done.opened;
			expect(codeOf(rejected)).toBe('CANCELED');
			expect(ran).toBe(false);
		});
	});
});

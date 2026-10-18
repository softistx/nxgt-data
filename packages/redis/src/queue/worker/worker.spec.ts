import { describe, expect, test } from 'bun:test';
import {
	eventually,
	gate,
	mailQueue,
	scriptCalls,
	useRedis,
} from '../../../test/fixtures';
import { JobError } from '../../errors/job-error';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
import { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
import type { Worker } from '../types';

const servers = useRedis();
const keys = queueKeys('mails');
const client = () => servers.redis.client;
const mails = () => bindQueue(client(), mailQueue);
const hget = (id: string, field: string) => client().hget(keys.job(id), field);
const state = (id: string) => hget(id, 'state');
const error = async (id: string) =>
	JSON.parse((await hget(id, 'error')) ?? 'null');

/** Starts a worker that the test closes, even when it fails. */
function started(worker: Worker, opened: Worker[]): Worker {
	opened.push(worker);
	return worker;
}

function suite() {
	const opened: Worker[] = [];
	return {
		work: (...args: Parameters<ReturnType<typeof mails>['work']>) =>
			started(mails().work(...args), opened),
		closeAll: async () => {
			for (const worker of opened.splice(0)) await worker.close();
		},
	};
}

describe('work', () => {
	test('runs an added job once and completes it', async () => {
		const { work, closeAll } = suite();
		try {
			const seen: unknown[] = [];
			work((job) => void seen.push(job));
			await mails().add({ to: 'a' }, { id: 'a' });
			await eventually(() => state('a'), 'completed');
			expect(seen).toEqual([
				{
					id: 'a',
					data: { to: 'a', template: 'welcome' },
					attempt: 1,
					attempts: 3,
				},
			]);
		} finally {
			await closeAll();
		}
	});

	test('a job added while the worker waits is picked up at once', async () => {
		const { work, closeAll } = suite();
		try {
			let at = 0;
			work(() => {
				at ||= Date.now();
			});
			await Bun.sleep(100); // the worker is blocked on the wake list
			const added = Date.now();
			await mails().add({ to: 'a' });
			await eventually(() => at > 0, true);
			expect(at - added).toBeLessThan(200);
		} finally {
			await closeAll();
		}
	});

	test('a delayed job runs when due, not before', async () => {
		const { work, closeAll } = suite();
		try {
			let calls = 0;
			work(() => {
				calls += 1;
			});
			await Bun.sleep(100); // blocked on an empty queue
			await mails().add({ to: 'a' }, { delay: 300 });
			await Bun.sleep(150);
			expect(calls).toBe(0);
			await eventually(() => calls, 1);
		} finally {
			await closeAll();
		}
	});

	test('a retry scheduled while the worker is blocked runs when due, not at the 5 s cap', async () => {
		const { work, closeAll } = suite();
		try {
			let calls = 0;
			work(() => {
				calls += 1;
				if (calls === 1) throw new JobError('later', { retryIn: 300 });
			});
			await mails().add({ to: 'a' }, { id: 'a' });
			const started = Date.now();
			await eventually(() => state('a'), 'completed');
			expect(calls).toBe(2);
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			await closeAll();
		}
	});

	test('close while the waiting connection is opening does not wait 5 s', async () => {
		const worker = mails().work(() => undefined);
		const before = Date.now();
		await worker.close();
		expect(Date.now() - before).toBeLessThan(1_000);
	});

	test('a throw retries with backoff, then fails for good after attempts', async () => {
		const { work, closeAll } = suite();
		try {
			let calls = 0;
			work(() => {
				calls += 1;
				throw new Error(`boom ${calls}`);
			});
			await mails().add({ to: 'a' }, { id: 'a' });
			await eventually(() => state('a'), 'failed');
			expect(calls).toBe(3);
			expect(await error('a')).toEqual({ name: 'Error', message: 'boom 3' });
		} finally {
			await closeAll();
		}
	});

	test('JobError retry false fails at once; retryIn sets the delay', async () => {
		const { work, closeAll } = suite();
		try {
			let calls = 0;
			work((job) => {
				calls += 1;
				if (job.id === 'stop') throw new JobError('no', { retry: false });
				throw new JobError('later', { retryIn: 600_000 });
			});
			await mails().add({ to: 'a' }, { id: 'stop' });
			await eventually(() => state('stop'), 'failed');
			expect(calls).toBe(1);
			await mails().add({ to: 'b' }, { id: 'later' });
			await eventually(() => state('later'), 'delayed');
			const due = Number(
				await client().send('ZSCORE', [keys.delayed, 'later']),
			);
			expect(Math.abs(due - (Date.now() + 600_000))).toBeLessThan(5_000);
		} finally {
			await closeAll();
		}
	});

	test('a thrown string is recorded readably', async () => {
		const { work, closeAll } = suite();
		try {
			work(() => {
				throw 'nope';
			});
			await mails().add({ to: 'a' }, { id: 'a' });
			await eventually(() => state('a'), 'delayed'); // retried, with the error kept
			expect(await error('a')).toEqual({ name: 'Error', message: 'nope' });
		} finally {
			await closeAll();
		}
	});

	test('concurrency runs that many at once, never more', async () => {
		const { work, closeAll } = suite();
		try {
			const release = gate();
			let running = 0;
			let most = 0;
			let done = 0;
			work(
				async () => {
					running += 1;
					most = Math.max(most, running);
					await release.opened;
					running -= 1;
					done += 1;
				},
				{ concurrency: 3 },
			);
			await mails().addMany(
				Array.from({ length: 10 }, (_, i) => ({ data: { to: `m${i}` } })),
			);
			await eventually(() => running, 3);
			await Bun.sleep(100);
			expect(running).toBe(3);
			release.open();
			await eventually(() => done, 10);
			expect(most).toBe(3);
		} finally {
			await closeAll();
		}
	});

	test('a busy worker spends one script per job', async () => {
		const { closeAll } = suite();
		// A 30 s lease: no renewal beat lands in the measure.
		const queue = bindQueue(
			client(),
			defineQueue({ name: 'mails', schema: mailQueue.schema, lease: '30s' }),
		);
		try {
			await queue.addMany(
				Array.from({ length: 50 }, (_, i) => ({ data: { to: `m${i}` } })),
			);
			let done = 0;
			let before = 0;
			const first = gate();
			const worker = queue.work(async () => {
				done += 1;
				if (done === 1) {
					before = await scriptCalls(client());
					first.open();
				}
			});
			try {
				await first.opened;
				await eventually(() => done, 50);
				await Bun.sleep(200); // idle: the worker found nothing and blocked
				const spent = (await scriptCalls(client())) - before;
				expect(spent).toBeLessThanOrEqual(55);
			} finally {
				await worker.close();
			}
		} finally {
			await closeAll();
		}
	});

	test('a job whose process died is reclaimed after its lease', async () => {
		const { work, closeAll } = suite();
		try {
			await mails().add({ to: 'a' }, { id: 'a' });
			// The dead process: it claims, then never renews nor settles.
			await claim(client(), keys, 1, mailQueue.lease);
			await Bun.sleep(350);
			const attempts: number[] = [];
			work((job) => void attempts.push(job.attempt));
			await eventually(() => state('a'), 'completed');
			expect(attempts).toEqual([2]);
			expect(await hget('a', 'attempt')).toBe('2');
		} finally {
			await closeAll();
		}
	});

	test('close waits for running jobs, then resolves without the 5 s wait, and closes its connection', async () => {
		const { work } = suite();
		let finished = false;
		const worker = work(async () => {
			await Bun.sleep(200);
			finished = true;
		});
		await mails().add({ to: 'a' }, { id: 'a' });
		await eventually(() => state('a'), 'active');
		const before = Date.now();
		await worker.close();
		const took = Date.now() - before;
		expect(finished).toBe(true);
		expect(took).toBeGreaterThanOrEqual(100);
		expect(took).toBeLessThan(1_000);
		expect(await state('a')).toBe('completed');
		await worker.close(); // idempotent
		// The worker's waiting connection is gone: only this client is left.
		const clients = (await client().send('CLIENT', ['LIST'])) as string;
		expect(clients.trim().split('\n').length).toBeLessThanOrEqual(2);
	});

	test('close of an idle worker is quick', async () => {
		const { work } = suite();
		const worker = work(() => undefined);
		await Bun.sleep(100);
		const before = Date.now();
		await worker[Symbol.asyncDispose]();
		expect(Date.now() - before).toBeLessThan(500);
	});

	test('a Redis failure is emitted on error and the loop carries on', async () => {
		const { work, closeAll } = suite();
		try {
			const handled: string[] = [];
			const worker = work((job) => void handled.push(job.id));
			const errors: unknown[] = [];
			worker.on('error', (e) => void errors.push(e));
			await Bun.sleep(100); // blocked on BLPOP
			await client().send('CLIENT', ['KILL', 'TYPE', 'normal']);
			await eventually(() => errors.length > 0, true);
			await mails().add({ to: 'a' }, { id: 'a' });
			await eventually(() => handled, ['a']);
		} finally {
			await closeAll();
		}
	});

	test('a listener that throws does not kill the loop', async () => {
		const { work, closeAll } = suite();
		try {
			const handled: string[] = [];
			const worker = work((job) => void handled.push(job.id));
			let heard = 0;
			worker.on('error', () => {
				heard += 1;
				throw new Error('bad listener');
			});
			await Bun.sleep(100);
			await client().send('CLIENT', ['KILL', 'TYPE', 'normal']);
			await eventually(() => heard > 0, true);
			await mails().add({ to: 'a' }, { id: 'a' });
			await eventually(() => handled, ['a']);
		} finally {
			await closeAll();
		}
	});

	test('data the schema now refuses fails the job without running it', async () => {
		const { work, closeAll } = suite();
		try {
			await mails().add({ to: 'a' }, { id: 'a' });
			await client().send('HSET', [keys.job('a'), 'data', '{"to":5}']);
			let calls = 0;
			work(() => {
				calls += 1;
			});
			await eventually(() => state('a'), 'failed');
			expect(calls).toBe(0);
			expect((await error('a')).name).toBe('QueueError');
		} finally {
			await closeAll();
		}
	});

	test('refuses a concurrency outside 1 to 1000', () => {
		for (const concurrency of [0, 1001, 1.5, Number.NaN]) {
			expect(() => mails().work(() => undefined, { concurrency })).toThrow(
				/concurrency/,
			);
		}
	});
});

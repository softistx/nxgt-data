import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { JobError } from '../../errors/job-error';
import { backoffDelay } from '../backoff';
import { decodeData } from '../encode';
import type { queueKeys } from '../keys';
import { claim } from '../scripts/claim';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
import { complete, fail } from '../scripts/settle';
import type {
	JobContext,
	QueueDefinition,
	Worker,
	WorkOptions,
} from '../types';
import { keepLeases } from './leases';

/** The longest a worker blocks: how it notices a token that went missing. */
const MAX_WAIT = 5_000;
/** The wait after a Redis failure, doubling up to the cap, reset by a success. */
const FIRST_RETRY = 1_000;
const MAX_RETRY = 30_000;

/** Checks `work`'s options and resolves them: a bare `TypeError`, as `defineQueue`'s refusals are. */
export function resolveWork(options: WorkOptions | undefined): {
	concurrency: number;
} {
	const concurrency = options?.concurrency ?? 1;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) {
		throw new TypeError(
			`work: concurrency must be a whole number from 1 to 1000, got ${String(concurrency)}`,
		);
	}
	return { concurrency };
}

/**
 * Runs a queue's jobs with `handler`, at most `concurrency` at once. A slot
 * that finishes a job settles it and claims the next in the same script, so a
 * busy worker spends one round trip per job; only an idle one waits, blocked
 * on the queue's `wake` list through a connection of its own.
 *
 * Nothing in the loop leaves a promise unhandled — Bun ends the process on
 * one — and a listener that throws is swallowed, never the loop's end.
 */
export function startWorker<S extends z.ZodType>(
	client: RedisClient,
	definition: QueueDefinition<S>,
	keys: ReturnType<typeof queueKeys>,
	handler: (job: JobContext<S>) => unknown,
	options: { concurrency: number },
): Worker {
	const { concurrency } = options;
	const listeners = new Set<(error: unknown) => void>();
	const slots = new Set<Promise<void>>();
	// A lost lease needs nothing here: the handler runs on and its late settle
	// is refused by the token check.
	const leases = keepLeases(client, keys, definition.lease, () => undefined);
	let open = true;
	let waiter: RedisClient | undefined;
	let slotFreed: (() => void) | undefined;
	const stopSleeping = new Set<() => void>();

	function emit(error: unknown): void {
		for (const listener of listeners) {
			try {
				listener(error);
			} catch {
				// A listener that throws must not end the loop.
			}
		}
	}

	/** Sleeps `ms`, or less when the worker closes. */
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				stopSleeping.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			stopSleeping.add(done);
		});
	}

	function toError(thrown: unknown): { name: string; message: string } {
		return thrown instanceof Error
			? { name: thrown.name, message: thrown.message }
			: { name: 'Error', message: String(thrown) };
	}

	/** Runs one job and settles it; answers the reply, whose job (if any) is the slot's next. */
	async function runJob(job: ClaimedJob): Promise<ClaimReply> {
		const decoded = decodeData(definition, job.data);
		if (!decoded.ok) {
			// The schema changed under a waiting job: never run, never retried.
			return await fail(
				client,
				keys,
				definition,
				job.id,
				job.token,
				{
					name: 'QueueError',
					message: 'INVALID: the stored data does not match the schema',
				},
				null,
				open,
			);
		}
		// Renewed until the settle is done, not just the handler: a slow settle
		// must not let the lease lapse under it.
		leases.add(job.id, job.token);
		try {
			return await runHandler(job, decoded.data);
		} finally {
			leases.delete(job.id);
		}
	}

	async function runHandler(
		job: ClaimedJob,
		data: z.output<S>,
	): Promise<ClaimReply> {
		let thrown: { error: unknown } | undefined;
		try {
			await handler({
				id: job.id,
				data,
				attempt: job.attempt,
				attempts: job.attempts,
			});
		} catch (error) {
			thrown = { error };
		}
		if (!thrown) {
			return await complete(client, keys, definition, job.id, job.token, open);
		}
		const { error } = thrown;
		const retryIn =
			error instanceof JobError
				? error.retry
					? (error.retryIn ?? backoffDelay(job.attempt, definition.backoff))
					: null
				: backoffDelay(job.attempt, definition.backoff);
		return await fail(
			client,
			keys,
			definition,
			job.id,
			job.token,
			toError(error),
			retryIn,
			open,
		);
	}

	/** One slot: runs the job it was given and each one its settle claimed. */
	async function runSlot(first: ClaimedJob): Promise<void> {
		let job: ClaimedJob | undefined = first;
		while (job) {
			try {
				const reply: ClaimReply = await runJob(job);
				job = reply.jobs[0];
			} catch (error) {
				// The job's lease lapses and another worker takes it back.
				emit(error);
				job = undefined;
			}
		}
	}

	function start(job: ClaimedJob): void {
		const slot: Promise<void> = runSlot(job)
			.then(undefined, emit)
			.then(() => {
				slots.delete(slot);
				slotFreed?.();
			});
		slots.add(slot);
	}

	async function waitForWork(next: number): Promise<void> {
		waiter ??= await client.duplicate();
		// Closed while the connection was opening: nothing to wait for.
		if (!open) return;
		const ms = Math.max(1, Math.min(next >= 0 ? next : MAX_WAIT, MAX_WAIT));
		await waiter.send('BLPOP', [keys.wake, String(ms / 1000)]);
	}

	async function loop(): Promise<void> {
		let retry = FIRST_RETRY;
		while (open) {
			try {
				const free = concurrency - slots.size;
				if (free <= 0) {
					await new Promise<void>((resolve) => {
						slotFreed = resolve;
					});
					slotFreed = undefined;
					continue;
				}
				const reply = await claim(client, keys, free, definition.lease);
				retry = FIRST_RETRY;
				for (const job of reply.jobs) start(job);
				if (open && slots.size < concurrency) await waitForWork(reply.next);
			} catch (error) {
				// Closing the connection ends a pending wait: expected then, and only then.
				if (!open) break;
				emit(error);
				await sleep(retry);
				retry = Math.min(retry * 2, MAX_RETRY);
			}
		}
		await waiter?.close();
	}

	const running = loop();
	let closing: Promise<void> | undefined;

	function close(): Promise<void> {
		closing ??= (async () => {
			open = false;
			slotFreed?.();
			for (const done of [...stopSleeping]) done();
			waiter?.close(); // ends a pending BLPOP at once
			await running;
			await Promise.all([...slots]);
			leases.stop();
		})();
		return closing;
	}

	return {
		close,
		on(_event, listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		[Symbol.asyncDispose]: close,
	};
}

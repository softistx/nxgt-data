import type { z } from 'zod';
import { claim } from '../scripts/claim';
import type { ClaimedJob } from '../scripts/replies';
import type { WorkerContext } from './context';
import { announce, emit } from './events';
import { markDrained, settleIdle } from './idle';
import { runSlot } from './run-job';

/** The longest a worker blocks: how it notices a token that went missing. */
const MAX_WAIT = 5_000;
/** The wait after a Redis failure, doubling up to the cap, reset by a success. */
const FIRST_RETRY = 1_000;
const MAX_RETRY = 30_000;

/** Sleeps `ms`, or less when the worker closes. */
function sleep(
	context: Pick<WorkerContext, 'stopSleeping'>,
	ms: number,
): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			context.stopSleeping.delete(done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		context.stopSleeping.add(done);
	});
}

function start<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
): void {
	const slot: Promise<void> = runSlot(context, job)
		.then(undefined, (error) => emit(context, 'error', error))
		.then(() => {
			context.slots.delete(slot);
			context.slotFreed?.();
			settleIdle(context);
		});
	context.slots.add(slot);
}

async function waitForWork(
	context: WorkerContext,
	next: number,
): Promise<void> {
	context.waiter ??= await context.client.duplicate();
	// Closed while the connection was opening: nothing to wait for.
	if (!context.open) return;
	const ms = Math.max(1, Math.min(next >= 0 ? next : MAX_WAIT, MAX_WAIT));
	await context.waiter.send('BLPOP', [context.keys.wake, String(ms / 1000)]);
}

/** Claims jobs into free slots, then waits for work, until the worker closes. */
export async function loop<S extends z.ZodType>(
	context: WorkerContext<S>,
): Promise<void> {
	let retry = FIRST_RETRY;
	while (context.open) {
		try {
			const free = context.concurrency - context.slots.size;
			if (free <= 0) {
				await new Promise<void>((resolve) => {
					context.slotFreed = resolve;
				});
				context.slotFreed = undefined;
				continue;
			}
			const reply = await claim(
				context.client,
				context.keys,
				free,
				context.definition.lease,
			);
			retry = FIRST_RETRY;
			announce(context, reply);
			for (const job of reply.jobs) start(context, job);
			markDrained(context, reply.jobs.length === 0);
			if (context.open && context.slots.size < context.concurrency) {
				await waitForWork(context, reply.next);
			}
		} catch (error) {
			// Closing the connection ends a pending wait: expected then, and only then.
			if (!context.open) break;
			emit(context, 'error', error);
			await sleep(context, retry);
			retry = Math.min(retry * 2, MAX_RETRY);
		}
	}
	await context.waiter?.close();
}

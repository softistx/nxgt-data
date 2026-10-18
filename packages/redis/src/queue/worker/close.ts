import type { Duration } from '../duration';
import { durationMs } from '../duration';
import { abortAll } from './abort';
import type { WorkerContext } from './context';
import { settleIdle } from './idle';

/** How long `close` waits for the running jobs when it is not told. */
const DEFAULT_GRACE = 30_000;

/** `close`'s `grace` in milliseconds: a bare `TypeError` that names the queue and never prints the value. */
export function resolveGrace(
	options: { grace?: Duration } | undefined,
	queue: string,
): number {
	if (options?.grace === undefined) return DEFAULT_GRACE;
	const grace = durationMs(options.grace);
	if (grace === undefined) {
		throw new TypeError(
			`close on "${queue}": grace is a whole number of milliseconds or a string such as '10s'`,
		);
	}
	return grace;
}

/** Resolves with `true` when `work` finished, `false` once `ms` passed first; the timer never outlives the call. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stops claiming, waits for the slots up to `grace`, then aborts what still
 * runs with `CLOSED`, stops the leases and the cancel listener.
 *
 * A job the loop claimed while closing is registered before the loop ends, so
 * the second `abortAll` after `running` catches it.
 */
export async function closeWorker(
	context: WorkerContext,
	running: Promise<void>,
	unlisten: Promise<() => Promise<void>>,
	grace: number,
): Promise<void> {
	context.open = false;
	context.slotFreed?.();
	for (const done of [...context.stopSleeping]) done();
	context.waiter?.close(); // ends a pending BLPOP at once
	const drained = async () => {
		await running;
		await Promise.all([...context.slots]);
	};
	if (!(await within(drained(), grace))) {
		abortAll(context);
		await running;
		abortAll(context);
		await Promise.all([...context.slots]);
	}
	context.leases.stop();
	await (await unlisten)();
	settleIdle(context);
}

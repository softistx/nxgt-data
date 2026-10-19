import type { Duration } from '../definition/duration';
import { durationMs } from '../definition/duration';
import { clampTimeout, RELEASE_MS } from '../timers';
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
		timer = setTimeout(() => resolve(false), clampTimeout(ms));
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
 * A job claimed while the worker is closing but before the loop ends is
 * registered and aborted by the second `abortAll`. Past the `RELEASE_MS` bound
 * `close` has resolved and the leases are stopped, so a late CLAIM or settle
 * reply starts nothing: its job keeps its lease, which lapses, and another
 * attempt retakes it, as for any `CLOSED` job.
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
		// What is left: a CLAIM or a settle on a server that stopped answering
		// without closing the socket must not hold `redis.close()`. Bounded,
		// and a rejection arriving late is swallowed.
		const left = (async () => {
			await running;
			abortAll(context);
			await Promise.all([...context.slots]);
		})();
		left.catch(() => undefined);
		await within(left, RELEASE_MS);
	}
	context.leases.stop();
	// A cancel listener whose connection is gone never answers: bounded, and a
	// rejection arriving late is swallowed.
	const unlistened = (async () => (await unlisten)())();
	unlistened.catch(() => undefined);
	await within(unlistened, RELEASE_MS);
	settleIdle(context);
}

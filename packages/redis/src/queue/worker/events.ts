import type { ClaimReply } from '../scripts/replies';
import type { WorkerEvents } from '../types';
import type { WorkerContext } from './context';

type Listening = Pick<WorkerContext, 'listeners'>;

/**
 * Tells every listener of `event`. A listener that throws (or whose promise
 * rejects) is reported on `'error'`; one of `'error'` that throws is
 * swallowed — it must not end the loop, nor loop on itself.
 */
export function emit<E extends keyof WorkerEvents>(
	context: Listening,
	event: E,
	payload: WorkerEvents[E],
): void {
	const set = context.listeners[event] as
		| Set<(payload: WorkerEvents[E]) => unknown>
		| undefined;
	if (!set) return;
	const report = (thrown: unknown) => {
		if (event !== 'error') emit(context, 'error', thrown);
	};
	for (const listener of [...set]) {
		try {
			const returned = listener(payload);
			if (returned instanceof Promise) returned.then(undefined, report);
		} catch (thrown) {
			report(thrown);
		}
	}
}

/** Adds a listener; answers the function that removes it. */
export function on<E extends keyof WorkerEvents>(
	context: Listening,
	event: E,
	listener: (payload: WorkerEvents[E]) => void,
): () => void {
	const sets = context.listeners as Record<
		string,
		Set<(payload: WorkerEvents[E]) => void> | undefined
	>;
	const set = sets[event] ?? new Set();
	sets[event] = set;
	set.add(listener);
	return () => void set.delete(listener);
}

/** What a claim's reply says happened to other jobs: leases taken back, jobs found unreadable. */
export function announce(context: Listening, reply: ClaimReply): void {
	for (const id of reply.stalled) emit(context, 'stalled', { id });
	for (const id of reply.failedInvalid) {
		emit(context, 'failed', {
			id,
			attempt: 0,
			error: {
				name: 'QueueError',
				message: 'INVALID: the stored job is not one this queue wrote',
			},
		});
	}
}

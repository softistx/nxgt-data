import type { WorkerContext } from './context';

type Draining = Pick<
	WorkerContext,
	'slots' | 'drained' | 'claims' | 'open' | 'idleWaiters' | 'client' | 'keys'
>;

function isIdle(context: Draining): boolean {
	return context.slots.size === 0 && (context.drained || !context.open);
}

/** Records what the last claim found, then wakes the `idle()` calls if that left the worker idle. */
export function markDrained(context: Draining, drained: boolean): void {
	context.drained = drained;
	context.claims += 1;
	settleIdle(context);
}

/** Wakes the `idle()` calls when no slot runs and the last claim found nothing. */
export function settleIdle(context: Draining): void {
	if (!isIdle(context)) return;
	for (const wake of [...context.idleWaiters]) wake();
	context.idleWaiters.clear();
}

/**
 * Resolves once no slot runs and the last claim found nothing ready. One
 * `ZCARD` on `ready` confirms an idle-looking worker first: a job added a
 * moment ago may not have woken the loop yet. When something waits, the call
 * joins `idleWaiters`, and the loop's next claim that finds nothing, with no
 * slot running, resolves it; the wake token guarantees that claim comes. It
 * never polls.
 */
export async function waitIdle(context: Draining): Promise<void> {
	if (!context.open) return;
	if (isIdle(context)) {
		const before = context.claims;
		const waiting = await context.client.send('ZCARD', [context.keys.ready]);
		if (!context.open) return;
		// A claim that ran meanwhile has already looked at what the ZCARD saw.
		if (waiting === 0 || context.claims !== before) {
			if (isIdle(context)) return;
		}
	}
	await new Promise<void>((resolve) => context.idleWaiters.add(resolve));
}

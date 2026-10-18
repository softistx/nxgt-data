import type { WorkerContext } from './context';

type Draining = Pick<
	WorkerContext,
	'slots' | 'drained' | 'open' | 'idleWaiters' | 'client' | 'keys'
>;

function isIdle(context: Draining): boolean {
	return context.slots.size === 0 && (context.drained || !context.open);
}

/** Records what the last claim found, then wakes the `idle()` calls if that left the worker idle. */
export function markDrained(context: Draining, drained: boolean): void {
	context.drained = drained;
	settleIdle(context);
}

/** Wakes the `idle()` calls when no slot runs and the last claim found nothing. */
export function settleIdle(context: Draining): void {
	if (!isIdle(context)) return;
	for (const wake of [...context.idleWaiters]) wake();
	context.idleWaiters.clear();
}

/**
 * Resolves once no slot runs and the last claim found nothing ready. A
 * worker that looks idle is confirmed against `ready` first: a job added a
 * moment ago may not have woken the loop yet, and `idle()` must wait for it.
 */
export async function waitIdle(context: Draining): Promise<void> {
	for (;;) {
		if (!isIdle(context)) {
			await new Promise<void>((resolve) => context.idleWaiters.add(resolve));
			continue;
		}
		if (!context.open) return;
		const waiting = await context.client.send('ZCARD', [context.keys.ready]);
		if (waiting === 0 && isIdle(context)) return;
		await Bun.sleep(5);
	}
}

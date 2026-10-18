import type { RedisClient } from 'bun';
import type { z } from 'zod';
import type { queueKeys } from '../keys';
import type {
	JobContext,
	QueueDefinition,
	Worker,
	WorkOptions,
} from '../types';
import type { WorkerContext } from './context';
import { on } from './events';
import { keepLeases } from './leases';
import { loop } from './loop';

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
	const context: WorkerContext<S> = {
		client,
		definition,
		keys,
		handler,
		concurrency: options.concurrency,
		// A lost lease needs nothing here: the handler runs on and its late settle
		// is refused by the token check.
		leases: keepLeases(client, keys, definition.lease, () => undefined),
		listeners: new Set(),
		slots: new Set(),
		stopSleeping: new Set(),
		open: true,
		waiter: undefined,
		slotFreed: undefined,
	};
	const running = loop(context);
	let closing: Promise<void> | undefined;

	function close(): Promise<void> {
		closing ??= (async () => {
			context.open = false;
			context.slotFreed?.();
			for (const done of [...context.stopSleeping]) done();
			context.waiter?.close(); // ends a pending BLPOP at once
			await running;
			await Promise.all([...context.slots]);
			context.leases.stop();
		})();
		return closing;
	}

	return {
		close,
		on: (_event, listener) => on(context, listener),
		[Symbol.asyncDispose]: close,
	};
}

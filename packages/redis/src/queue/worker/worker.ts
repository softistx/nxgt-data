import type { RedisClient } from 'bun';
import type { z } from 'zod';
import type { Duration } from '../duration';
import type { queueKeys } from '../keys';
import type { QueueDefinition } from '../types/queue';
import { abortLost, hearCancels } from './abort';
import { closeWorker, resolveGrace } from './close';
import type { WorkerContext } from './context';
import { emit, on } from './events';
import { waitIdle } from './idle';
import { keepLeases } from './leases';
import { loop } from './loop';
import type { JobContext, Worker, WorkOptions } from './types';

/** Checks `work`'s options and resolves them: a bare `TypeError` that names the queue and never prints the value. */
export function resolveWork(
	options: WorkOptions | undefined,
	queue: string,
): {
	concurrency: number;
} {
	const concurrency = options?.concurrency ?? 1;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) {
		throw new TypeError(
			`work on "${queue}": concurrency is a whole number from 1 to 1000`,
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
	definition: QueueDefinition<S, z.ZodType | undefined>,
	keys: ReturnType<typeof queueKeys>,
	handler: (job: JobContext<S>) => unknown,
	options: { concurrency: number; prefix: string | undefined },
): Worker {
	const context: WorkerContext<S> = {
		client,
		definition,
		keys,
		handler,
		concurrency: options.concurrency,
		prefix: options.prefix,
		// A lost lease aborts that run; its late settle would be refused anyway.
		leases: keepLeases(client, keys, definition.lease, (lost) =>
			abortLost(context, lost),
		),
		runs: new Map(),
		listeners: {},
		idleWaiters: new Set(),
		drained: false,
		claims: 0,
		slots: new Set(),
		stopSleeping: new Set(),
		open: true,
		waiter: undefined,
		slotFreed: undefined,
	};
	// Taken where it is made: a rejection nobody awaits ends a Bun process, and
	// `close` is not always called.
	const running = loop(context).catch((error) => emit(context, 'error', error));
	// Heard from the start, but no claim waits for it. Resolves with the
	// function that stops listening; a failure is reported, and the worker
	// then learns of a cancel through the lease renewal instead.
	const unlisten = hearCancels(context).catch((error) => {
		emit(context, 'error', error);
		return async () => undefined;
	});
	let closing: Promise<void> | undefined;

	// Only the first call's `grace` is read, and checked: a later call gets
	// the first call's promise whatever it passes.
	function close(options?: { grace?: Duration }): Promise<void> {
		if (closing) return closing;
		let grace: number;
		try {
			grace = resolveGrace(options, definition.name);
		} catch (error) {
			return Promise.reject(error);
		}
		closing = closeWorker(context, running, unlisten, grace);
		return closing;
	}

	return {
		close,
		on: (event, listener) => on(context, event, listener),
		idle: () => waitIdle(context),
		[Symbol.asyncDispose]: () => close(),
	};
}

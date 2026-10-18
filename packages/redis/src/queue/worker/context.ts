import type { RedisClient } from 'bun';
import type { z } from 'zod';
import type { queueKeys } from '../keys';
import type { JobContext, QueueDefinition, WorkerEvents } from '../types';
import type { Leases } from './leases';

/**
 * What one running worker works from: the client, the queue, the handler and
 * the few things that change while it runs (the open flag, the waiting
 * connection, the slots).
 *
 * It holds data and the worker's live handles — the lease keeper, the
 * waiting connection, the wake-ups — but no behaviour of its own. `run-job.ts`,
 * `loop.ts` and `events.ts` are plain functions that take it as their first
 * argument, as `collection/context.ts` does in `@nxgt/mongo` — a context of
 * closures would only be the factory this file split up, one size down.
 */
export interface WorkerContext<S extends z.ZodType = z.ZodType> {
	readonly client: RedisClient;
	readonly definition: QueueDefinition<S, z.ZodType | undefined>;
	readonly keys: ReturnType<typeof queueKeys>;
	readonly handler: (job: JobContext<S>) => unknown;
	readonly concurrency: number;
	readonly leases: Leases;
	/** The listeners of each event, added by `Worker.on`. */
	readonly listeners: {
		[E in keyof WorkerEvents]?: Set<(payload: WorkerEvents[E]) => void>;
	};
	/** Resolves of the `idle()` calls waiting for the worker to drain. */
	readonly idleWaiters: Set<() => void>;
	/** The jobs being run, one promise per slot. */
	readonly slots: Set<Promise<void>>;
	/** Wakes the sleeps of the error backoff when the worker closes. */
	readonly stopSleeping: Set<() => void>;
	/** False once `close` was called. */
	open: boolean;
	/** The connection of its own an idle worker blocks on, opened on first use. */
	waiter: RedisClient | undefined;
	/** True once a claim found nothing ready; false while the first claim is pending and again once a claim hands out a job. */
	drained: boolean;
	/** Resolves the loop's wait for a free slot. */
	slotFreed: (() => void) | undefined;
}

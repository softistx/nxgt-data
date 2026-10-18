import type { z } from 'zod';
import type { Duration } from '../duration';
import type { ResultInputOf } from '../result-types';

/** What `step` takes beside the function. */
export type StepOptions<Z extends z.ZodType> = {
	/**
	 * Checks the step's value: what `fn` returns goes through it and its
	 * output is stored, and a stored value is parsed by it on read. Without a
	 * schema the value must survive the JSON round trip.
	 */
	schema: Z;
};

/** What a handler receives. */
export type JobContext<S extends z.ZodType> = {
	id: string;
	/** The payload, parsed by the schema. */
	data: z.output<S>;
	/** This run, counting from 1. */
	attempt: number;
	/** The runs the queue allows. */
	attempts: number;
	/** Aborts when the run is canceled, times out, loses its lease or the worker closes. */
	signal: AbortSignal;
	/** Reports how far the job is, a number from 0 to 100. */
	progress(value: number): Promise<void>;
	/**
	 * Runs `fn` once per job and stores its value: a later attempt, or a run
	 * after `retry(id)`, gets the stored value and `fn` does not run. A step
	 * costs two round trips when it runs (a begin, which also pushes the lease
	 * a full lease ahead, and a commit) and one when it is already stored.
	 * Both are refused once this attempt lost its lease: `step` then rejects
	 * with a `QueueError` `LEASE_LOST` and `fn` does not run.
	 *
	 * `name` is 1 to 128 characters without `:`, and one name runs once per
	 * attempt; anything else is a `TypeError`. A throw from `fn` is the
	 * handler's own error and records nothing. A value that cannot be stored,
	 * or a stored one the schema refuses, rejects with a `QueueError`
	 * `INVALID`, which fails the job without retry.
	 */
	step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
	step<Z extends z.ZodType>(
		name: string,
		fn: () => z.input<Z> | Promise<z.input<Z>>,
		options: StepOptions<Z>,
	): Promise<z.output<Z>>;
	/**
	 * A key for work outside the queue that must happen once per job, such as
	 * an idempotency key: `<queue name>:<job id>:<name>`, the same on every
	 * attempt. `name` follows the rules of a step's.
	 */
	key(name: string): string;
};

/** What a handler of a queue with result schema `R` is: it returns the schema's input; without a result schema the return is ignored. */
export type Handler<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = (job: JobContext<S>) => ResultInputOf<R> | Promise<ResultInputOf<R>>;

/** What `work` takes. */
export type WorkOptions = {
	/** Jobs run at once: a whole number, 1 to 1000. Default 1. */
	concurrency?: number;
};

/** What a worker tells, by event name. */
export type WorkerEvents = {
	/** A run started. */
	active: { id: string; attempt: number };
	/** A handler reported progress. */
	progress: { id: string; progress: number };
	/** A run completed; `duration` is in milliseconds. */
	completed: { id: string; attempt: number; duration: number };
	/** A run failed and will be retried after `delay` milliseconds. */
	retrying: {
		id: string;
		attempt: number;
		delay: number;
		error: { name: string; message: string };
	};
	/**
	 * A run failed for good. A job the claim found unreadable is reported with
	 * `attempt: 0` and the error `INVALID: the stored job is not one this queue
	 * wrote`.
	 */
	failed: {
		id: string;
		attempt: number;
		error: { name: string; message: string };
	};
	/** A run lost its lease and was taken back. */
	stalled: { id: string };
	/** A running job was canceled. A cancel that arrives while the handler's completion is being settled emits nothing: the settle is refused. */
	canceled: { id: string };
	/** What the loop could not handle. */
	error: unknown;
};

/** A running worker. */
export type Worker = {
	/**
	 * Stops taking jobs and resolves once the running ones have finished, or
	 * after `grace` (default 30 seconds) once their signals have aborted. A
	 * `grace` above about 24.8 days (2147483647 ms, the longest a timer
	 * waits) waits 24.8 days. Only the first call's `grace` is read and
	 * checked; a later call gets the same promise whatever it passes, a
	 * malformed `grace` included.
	 */
	close(options?: { grace?: Duration }): Promise<void>;
	/**
	 * Resolves once no slot is running and the last claim found nothing ready;
	 * at once when that already holds, and at once after `close`. The next
	 * claimed job re-arms it. A job that was aborted (canceled, timed out, lost
	 * its lease or cut off by `close`) frees its slot at once, so `idle` can
	 * resolve while its handler, which ignored the signal, still runs.
	 */
	idle(): Promise<void>;
	/** Listens to an event; returns the way to stop listening. */
	on<E extends keyof WorkerEvents>(
		event: E,
		listener: (payload: WorkerEvents[E]) => void,
	): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

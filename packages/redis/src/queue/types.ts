import type { z } from 'zod';
import type { Duration } from './duration';

/** What a handler of a queue with result schema `R` returns: the schema's input, or nothing. */
export type ResultInputOf<R> = R extends z.ZodType ? z.input<R> : void;

/** What a finished job of a queue with result schema `R` holds: the schema's output, or `undefined`. */
export type ResultOf<R> = R extends z.ZodType ? z.output<R> : undefined;

/** What `defineQueue` takes. Every span of time is a {@link Duration}. */
export type QueueInput<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	/**
	 * The queue's name, in its keys. No braces: the name is the hash tag, so
	 * every key of one queue lands on the same Redis Cluster slot.
	 */
	name: string;
	/** Checked on `add` and again on the way out, so a bad payload never runs. */
	schema: S;
	/**
	 * What a handler returns, checked on the way in and again when it is read.
	 * Without it a handler returns nothing and `finished` resolves to `undefined`.
	 */
	result?: R;
	/** Runs of one job before it fails for good. Default 3. */
	attempts?: number;
	/** The wait before a retry, doubling from `base` up to `max`, with full jitter. */
	backoff?: {
		/** Default 1 second. */
		base?: Duration;
		/** Default 1 hour. */
		max?: Duration;
	};
	/**
	 * How long a worker holds a job before another may take it back. A running
	 * worker renews it every third of it. Default 30 seconds, at least 30 ms.
	 */
	lease?: Duration;
	/**
	 * How long finished jobs stay readable, and how many. `false` removes a
	 * job as soon as it completes. Default 1 hour, 1000 jobs.
	 */
	keepCompleted?: false | { age?: Duration; count?: number };
	/** How long a failed job stays readable. Default 7 days. */
	keepFailed?: Duration;
	/**
	 * How long one run may take before it is aborted and counted as a failed
	 * attempt, at least 1 ms. No limit by default; `add` may set one per job.
	 */
	timeout?: Duration;
};

/** What `defineQueue` returns: frozen, every option resolved, spans in milliseconds. */
export type QueueDefinition<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	readonly name: string;
	readonly schema: S;
	readonly result: R;
	readonly attempts: number;
	readonly backoff: { readonly base: number; readonly max: number };
	readonly lease: number;
	readonly keepCompleted:
		| false
		| { readonly age: number; readonly count: number };
	readonly keepFailed: number;
	readonly timeout: number | undefined;
};

/** What `add` takes beside the payload. `delay` and `at` are two ways to say the same thing. */
export type AddOptions = {
	/** The job's id, 1 to 256 characters without braces. Adding an id twice keeps the first. */
	id?: string;
	/** Whole number, 0 to 1000; a lower one runs first. Default 0. */
	priority?: number;
	/** Overrides the queue's `timeout` for this job. */
	timeout?: Duration;
} & ({ delay?: Duration; at?: never } | { at?: Date; delay?: never });

/** What `add` hands back. */
export type JobHandle<R extends z.ZodType | undefined = undefined> = {
	readonly id: string;
	/** `true` when the id was already in the queue, so nothing was added. */
	readonly deduplicated: boolean;
	/**
	 * Resolves with the job's result once it completes. No deadline unless
	 * `timeout` is given.
	 *
	 * A job that is not in the queue is `NOT_FOUND`: that includes one with
	 * `keepCompleted: false` that finished before the call, and a canceled job
	 * whose event was missed (the cancel deletes it).
	 *
	 * @throws QueueError `FAILED` when the job fails for good, `CANCELED` when
	 * it is canceled, `NOT_FOUND` when the job is not in the queue, `INVALID`
	 * when its result does not match the result schema, `WAIT_TIMEOUT` when
	 * `timeout` passes first.
	 * @throws TypeError for a malformed `timeout`.
	 */
	finished(options?: { timeout?: Duration }): Promise<ResultOf<R>>;
	/** Cancels the job: `true` when it was waiting, delayed or running, `false` when there was nothing to cancel. */
	cancel(): Promise<boolean>;
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
};

/** What a handler of a queue with result schema `R` is: it returns the schema's input, or nothing. */
export type Handler<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = (job: JobContext<S>) => ResultInputOf<R> | Promise<ResultInputOf<R>>;

/** Where a job is. */
export type JobState =
	| 'waiting'
	| 'delayed'
	| 'active'
	| 'completed'
	| 'failed';

/** A job as `get` and `list` show it. */
export type JobView<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	id: string;
	state: JobState;
	/** `undefined` when the stored payload no longer parses with the schema. */
	data: z.output<S> | undefined;
	attempt: number;
	attempts: number;
	priority: number;
	/** The last failure: its name and message, never a stack. */
	error?: { name: string; message: string };
	added: Date;
	/** When the job is next due to run. */
	runAt: Date;
	finished?: Date;
	/** How far the job reported it is, 0 to 100; 0 until it reports. */
	progress: number;
	/** What the handler returned, once the job has completed. */
	result?: ResultOf<R>;
};

/** How many jobs are in each state. */
export type QueueCounts = Record<JobState, number>;

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
	/** A run failed for good. */
	failed: {
		id: string;
		attempt: number;
		error: { name: string; message: string };
	};
	/** A run lost its lease and was taken back. */
	stalled: { id: string };
	/** A running job was canceled. */
	canceled: { id: string };
	/** What the loop could not handle. */
	error: unknown;
};

/** A running worker. */
export type Worker = {
	/**
	 * Stops taking jobs and resolves once the running ones have finished, or
	 * after `grace` (default 30 seconds) once their signals have aborted.
	 */
	close(options?: { grace?: Duration }): Promise<void>;
	/** Resolves once no job is running or claimed. */
	idle(): Promise<void>;
	/** Listens to an event; returns the way to stop listening. */
	on<E extends keyof WorkerEvents>(
		event: E,
		listener: (payload: WorkerEvents[E]) => void,
	): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

/** A queue bound to a client. */
export type BoundQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	readonly definition: QueueDefinition<S, R>;
	/**
	 * Adds a job: one script, one round trip. The payload is checked by the
	 * schema and stored as its output, defaults applied.
	 *
	 * @throws QueueError `INVALID` when the schema refuses the payload, or it
	 * does not survive JSON; nothing is written.
	 * @throws TypeError for a malformed option.
	 */
	add(data: z.input<S>, options?: AddOptions): Promise<JobHandle<R>>;
	/**
	 * Adds many jobs, one script per 500, handles in the order given. One bad
	 * item refuses the whole call before anything is written.
	 */
	addMany(
		items: readonly { data: z.input<S>; options?: AddOptions }[],
	): Promise<JobHandle<R>[]>;
	/**
	 * Starts a worker: it runs the queue's jobs with `handler`, at most
	 * `concurrency` at once, and settles each by what the handler does — a
	 * return completes it, a throw retries it or fails it for good.
	 *
	 * @throws TypeError for a malformed option.
	 */
	work(handler: Handler<S, R>, options?: WorkOptions): Worker;
	/** One job as it is stored, or `undefined` when there is none. */
	get(id: string): Promise<JobView<S, R> | undefined>;
	/**
	 * One page of the jobs in `state`. `waiting`, `delayed` and `active` come
	 * oldest first, in the order they will be taken; `completed` and `failed`
	 * newest first. A job removed while the page is read is left out, so a
	 * page may be shorter than `limit`.
	 *
	 * @param page - `offset` from 0, default 0; `limit` from 1 to 1000, default 50.
	 * @throws TypeError for an `offset` or `limit` out of range.
	 */
	list(
		state: JobState,
		page?: { offset?: number; limit?: number },
	): Promise<JobView<S, R>[]>;
	/** How many jobs are in each state, from one script. */
	counts(): Promise<QueueCounts>;
	/**
	 * Puts a failed job back to `waiting`: its attempts start again from 0 and
	 * its last error is cleared.
	 *
	 * @throws QueueError `NOT_FOUND` when the job is not failed.
	 */
	retry(id: string): Promise<void>;
	/**
	 * Deletes a job in any state but `active`.
	 *
	 * @throws QueueError `ACTIVE` for a running job, `NOT_FOUND` for none.
	 */
	remove(id: string): Promise<void>;
	/**
	 * Cancels a job: `true` when it was waiting, delayed or running, `false`
	 * when there was nothing to cancel (finished, removed or unknown).
	 */
	cancel(id: string): Promise<boolean>;
};

import type { z } from 'zod';
import type { Duration } from './duration';
import type { JobHandle } from './handle-types';
import type { ResultOf } from './result-types';
import type { Handler, Worker, WorkOptions } from './worker/types';

/** What `defineQueue` takes. Every span of time is a {@link Duration}. */
export type QueueInput<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	/**
	 * The queue's name, in its keys. No braces: the name is the hash tag, so
	 * every key of one queue lands on the same Redis Cluster slot. No colon:
	 * `job.key` joins the name, the job id and the step name with colons.
	 */
	name: string;
	/** Checked on `add` and again on the way out, so a bad payload never runs. */
	schema: S;
	/**
	 * What a handler returns, checked on the way in and again when it is read.
	 * Without it the handler may return anything: the value is ignored and
	 * never stored, and `finished` resolves to `undefined`.
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
	 * Timeouts above about 24.8 days (2147483647 ms, the longest a timer waits)
	 * run as 24.8 days.
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

/** What `retry` takes beside the id. */
export type RetryOptions = {
	/**
	 * `true` clears the job's stored step values so every `job.step` runs
	 * again; `false` or absent keeps them. Default `false`.
	 */
	fresh?: boolean;
};

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
export type QueueCounts = Record<JobState, number> & { paused: boolean };

/** A queue bound to a client. */
export type BoundQueue<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
> = {
	readonly definition: QueueDefinition<S, R>;
	/**
	 * The prefix the queue is wired under, or `undefined` for one bound by
	 * hand. It is part of the storage name and of `job.key`, never of
	 * `definition.name`.
	 */
	readonly prefix: string | undefined;
	/**
	 * Adds a job: one script, one round trip. The payload is checked by the
	 * schema and stored as its output, defaults applied.
	 *
	 * @throws QueueError `INVALID` when the schema refuses the payload, or it
	 * does not survive JSON; nothing is written.
	 * @throws TypeError for a malformed option.
	 *
	 * An add in flight when the connection closes fails with the connection's
	 * error, not `CLOSED`.
	 */
	add(data: z.input<S>, options?: AddOptions): Promise<JobHandle<R>>;
	/**
	 * Adds many jobs, one script per 500, handles in the order given. One bad
	 * item refuses the whole call before anything is written. On a wired queue
	 * whose Redis closes in between, it stops with `CLOSED` before its next
	 * script, the jobs already sent staying written. An add in flight when the
	 * connection closes fails with the connection's error, not `CLOSED`.
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
	/** How many jobs are in each state, and whether it is paused: one script. */
	counts(): Promise<QueueCounts>;
	/**
	 * Pauses the queue for every worker of every process: no new job is
	 * claimed. Running jobs finish and settle, and a settle claims nothing
	 * next. Delayed jobs still become due and lapsed leases are still
	 * reclaimed, so `counts()` stays honest. Idempotent, and it works after
	 * the Redis is closed, as `counts()` does.
	 */
	pause(): Promise<void>;
	/**
	 * Lifts a pause: blocked workers start claiming at once. Idempotent.
	 */
	resume(): Promise<void>;
	/**
	 * Puts a failed job back to `waiting`: its attempts start again from 0 and
	 * its last error is cleared. Its steps are kept by default, so the next
	 * run resumes after the last one that finished; with `{ fresh: true }`
	 * they are cleared, in the same script, and every step runs again. The
	 * job's `job.key(name)` is the same either way.
	 *
	 * @throws TypeError for a `fresh` that is not `true` or `false`, before
	 * any round trip.
	 * @throws QueueError `NOT_FOUND` when the job is not failed (its steps are
	 * then kept, `fresh` or not).
	 */
	retry(id: string, options?: RetryOptions): Promise<void>;
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

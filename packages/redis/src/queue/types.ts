import type { z } from 'zod';
import type { Duration } from './duration';

/** What `defineQueue` takes. Every span of time is a {@link Duration}. */
export type QueueInput<S extends z.ZodType> = {
	/**
	 * The queue's name, in its keys. No braces: the name is the hash tag, so
	 * every key of one queue lands on the same Redis Cluster slot.
	 */
	name: string;
	/** Checked on `add` and again on the way out, so a bad payload never runs. */
	schema: S;
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
};

/** What `defineQueue` returns: frozen, every option resolved, spans in milliseconds. */
export type QueueDefinition<S extends z.ZodType> = {
	readonly name: string;
	readonly schema: S;
	readonly attempts: number;
	readonly backoff: { readonly base: number; readonly max: number };
	readonly lease: number;
	readonly keepCompleted:
		| false
		| { readonly age: number; readonly count: number };
	readonly keepFailed: number;
};

/** What `add` takes beside the payload. `delay` and `at` are two ways to say the same thing. */
export type AddOptions = {
	/** The job's id, 1 to 256 characters without braces. Adding an id twice keeps the first. */
	id?: string;
	/** Whole number, 0 to 1000; a lower one runs first. Default 0. */
	priority?: number;
} & ({ delay?: Duration; at?: never } | { at?: Date; delay?: never });

/** What `add` hands back. */
export type JobHandle = {
	readonly id: string;
	/** `true` when the id was already in the queue, so nothing was added. */
	readonly deduplicated: boolean;
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
};

/** Where a job is. */
export type JobState =
	| 'waiting'
	| 'delayed'
	| 'active'
	| 'completed'
	| 'failed';

/** A job as `get` and `list` show it. */
export type JobView<S extends z.ZodType> = {
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
};

/** How many jobs are in each state. */
export type QueueCounts = Record<JobState, number>;

/** What `work` takes. */
export type WorkOptions = {
	/** Jobs run at once: a whole number, 1 to 1000. Default 1. */
	concurrency?: number;
};

/** A running worker. */
export type Worker = {
	/** Stops taking jobs and resolves once the running ones have finished. */
	close(): Promise<void>;
	/** Listens to what the loop could not handle; returns the way to stop listening. */
	on(event: 'error', listener: (error: unknown) => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * A queue bound to a client. It grows with the queue's tasks: `work` and the
 * inspection calls arrive with theirs.
 */
export type BoundQueue<S extends z.ZodType> = {
	readonly definition: QueueDefinition<S>;
	/**
	 * Adds a job: one script, one round trip. The payload is checked by the
	 * schema and stored as its output, defaults applied.
	 *
	 * @throws QueueError `INVALID` when the schema refuses the payload, or it
	 * does not survive JSON; nothing is written.
	 * @throws TypeError for a malformed option.
	 */
	add(data: z.input<S>, options?: AddOptions): Promise<JobHandle>;
	/**
	 * Adds many jobs, one script per 500, handles in the order given. One bad
	 * item refuses the whole call before anything is written.
	 */
	addMany(
		items: readonly { data: z.input<S>; options?: AddOptions }[],
	): Promise<JobHandle[]>;
};

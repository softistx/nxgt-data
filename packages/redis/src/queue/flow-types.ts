import type { Duration } from './duration';

/**
 * What a queue's `rateLimit` takes: a limit shared by every worker of every
 * process, counted by the same GCRA as `defineRateLimit`. At most `limit`
 * jobs start per `per`, with up to `burst` at once after a quiet spell.
 *
 * ```ts
 * defineQueue({ name: 'mails', schema, rateLimit: { limit: 10, per: '1s' } });
 * ```
 */
export type QueueRateLimit = {
	/** Jobs that may start per `per`: a whole number, at least 1. */
	limit: number;
	/** The span `limit` is counted over, at least 1 ms. */
	per: Duration;
	/** Jobs that may start at once from a full bucket: a whole number, at least 1. Default `limit`. */
	burst?: number;
};

/** A queue's `rateLimit` as `defineQueue` resolves it: frozen, `per` in milliseconds, `burst` filled. */
export type QueueRate = {
	readonly limit: number;
	readonly per: number;
	readonly burst: number;
};

/**
 * What `add`'s `debounce` takes: jobs added under one `key` collapse into one
 * that runs `wait` after the last of them. While that job is still waiting
 * (`waiting` or `delayed`) a new add replaces its data and pushes its run time
 * back, answering its id (`deduplicated: true`); once it runs, or has run, the
 * next add makes a new job. It keeps its priority, attempts and timeout.
 *
 * The state decides while the key lives, which is `wait` plus a day; a job
 * left waiting longer (a paused queue, no worker, a backlog) can be joined by
 * a second one.
 *
 * ```ts
 * await queue.add({ docId }, { debounce: { key: docId, wait: '30s' } });
 * ```
 */
export type DebounceOptions = {
	/** 1 to 256 characters, no braces. Scoped to the queue. */
	key: string;
	/** How long after the last add the job runs, at least 1 ms. */
	wait: Duration;
};

/**
 * What `add`'s `throttle` takes: the first add under `key` makes a job, and
 * every add under it within `window` adds nothing and answers that job's id
 * (`deduplicated: true`), even after the job has finished.
 *
 * ```ts
 * await queue.add({ userId }, { throttle: { key: userId, window: '1h' } });
 * ```
 */
export type ThrottleOptions = {
	/** 1 to 256 characters, no braces. Scoped to the queue. */
	key: string;
	/** How long the first add's key holds, from that add; at least 1 ms. */
	window: Duration;
};

/** `delay` and `at` are two ways to say the same thing: give one. */
type AddTime = { delay?: Duration; at?: never } | { at?: Date; delay?: never };

/**
 * The part of `add`'s options that depends on how the job is named: by an
 * `id`, by a `debounce` key or by a `throttle` key. A key names the job, so
 * neither takes an `id`; they exclude each other; and `debounce` sets the run
 * time itself, so it takes no `delay` or `at`.
 */
export type AddKeyed =
	| ({
			/** The job's id, 1 to 256 characters without braces. Adding an id twice keeps the first. */
			id?: string;
			debounce?: never;
			throttle?: never;
	  } & AddTime)
	| {
			debounce: DebounceOptions;
			throttle?: never;
			id?: never;
			delay?: never;
			at?: never;
	  }
	| ({ throttle: ThrottleOptions; debounce?: never; id?: never } & AddTime);

/** A queue's `groups` as `defineQueue` resolves it: `concurrency` is 0 for no cap. */
export type QueueGroups = {
	readonly concurrency: number;
};

/**
 * What `defineQueue` takes as `groups`: `concurrency` is the most jobs of one
 * group that run at once, across every worker, a whole number from 1. Left
 * out, groups take fair turns and have no cap.
 */
export type QueueGroupsInput = {
	concurrency?: number;
};

/** What `retry` takes beside the id. */
export type RetryOptions = {
	/**
	 * `true` clears the job's stored step values so every `job.step` runs
	 * again; `false` or absent keeps them. Default `false`.
	 */
	fresh?: boolean;
};

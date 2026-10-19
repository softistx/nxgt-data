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

import { type Duration, toMs } from '../queue/duration';

/**
 * What a handler throws to say how the failed attempt is retried. Any other
 * error is retried by the queue's own backoff; this one overrides it.
 *
 * - `new JobError(message)`: retry as the backoff says.
 * - `{ retry: false }`: fail the job for good, whatever attempts remain.
 * - `{ retryIn }`: retry after that long instead of the backoff's delay.
 *
 * The two options exclude each other, in the types: giving up and choosing a
 * delay say opposite things.
 */
export class JobError extends Error {
	/** `false` when the handler gave up on the job. */
	readonly retry: boolean;
	/** Milliseconds until the next attempt, when the handler chose one. */
	readonly retryIn?: number;

	constructor(
		message: string,
		options?:
			| { retry: false; retryIn?: never }
			| { retryIn: Duration; retry?: never },
	) {
		super(message);
		this.name = 'JobError';
		this.retry = !(options && 'retry' in options);
		if (options && 'retryIn' in options) {
			this.retryIn = toMs(options.retryIn, 'retryIn');
		}
	}
}

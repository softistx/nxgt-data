/** What a guard refused. Each one is in the README's Errors table. */
export type GuardErrorCode =
	/** `enforce` found the limit spent. `retryAfter` says when to try again. */
	| 'RATE_LIMITED'
	/** A cost that is not a whole number within the definition's burst. */
	| 'COST'
	/**
	 * `run` found the same key still running elsewhere. `retryAfter` says
	 * when its lease ends — by then it has finished, or it has lapsed.
	 */
	| 'IN_PROGRESS'
	/** `run` found the key first used with a different fingerprint. */
	| 'MISMATCH'
	/**
	 * A result the schema refuses: what `work` returned, which is then not
	 * stored, or what was stored, which is then not run again. Also a stored
	 * record `run` could not have written.
	 */
	| 'INVALID'
	/**
	 * `work` finished after its lease lapsed, so a repeat may have run it
	 * too. Its result was not stored.
	 */
	| 'LEASE_LOST';

/**
 * This package's only error. Redis's own failures come back as they are, from
 * Bun's client; this is for what *this* package decides.
 *
 * It names the **definition** it happened on, never the key it built nor the
 * params it built it from, a fingerprint or a result: those came from a
 * request, and a log line is no place for a user id or an address.
 */
export class GuardError extends Error {
	readonly code: GuardErrorCode;
	/** The definition's `name`, the only part of the key that is not a request's. */
	readonly definition: string;
	/**
	 * For `RATE_LIMITED`: milliseconds until the same call would be allowed;
	 * for `IN_PROGRESS`: milliseconds until the running call's lease ends.
	 * Measured on the Redis server's clock. A delay, never a date — the
	 * caller's clock and the server's need not agree.
	 */
	readonly retryAfter?: number;

	constructor(
		code: GuardErrorCode,
		definition: string,
		message: string,
		options?: { retryAfter?: number },
	) {
		super(message);
		this.name = 'GuardError';
		this.code = code;
		this.definition = definition;
		if (options?.retryAfter !== undefined) {
			this.retryAfter = options.retryAfter;
		}
	}
}

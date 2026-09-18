/** What went wrong. Each one is documented in the README's Traps. */
export type RedisErrorCode =
	/** A lock was held by somebody else, and `wait` ran out. */
	| 'LOCK_HELD'
	/** A lock expired while its work was still running. */
	| 'LOCK_LOST'
	/** A value does not match the schema it is stored or published under. */
	| 'INVALID';

/**
 * This package's only error. Redis's own failures come back as they are,
 * from Bun's client; this is for what *this* package decides.
 */
export class RedisError extends Error {
	readonly code: RedisErrorCode;
	/** The key or channel it happened on, without any value. */
	readonly key: string;

	constructor(
		code: RedisErrorCode,
		key: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = 'RedisError';
		this.code = code;
		this.key = key;
	}
}

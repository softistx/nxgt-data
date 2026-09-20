/** What went wrong. Each one is documented in the README's Traps. */
export type RedisErrorCode =
	/** A lock was held by somebody else, and `wait` ran out. */
	| 'LOCK_HELD'
	/** A lock expired while its work was still running. */
	| 'LOCK_LOST'
	/** A value does not match the schema it is stored or published under. */
	| 'INVALID'
	/**
	 * The shared client was closed while this `connectRedis` was still waiting
	 * for it. Redis's own refusal to connect is Bun's error, and reaches the
	 * caller unchanged; this is only what *this* package decides.
	 */
	| 'CONNECTION'
	/** `ping` gave up waiting. It is returned on the result, never thrown. */
	| 'PING_TIMEOUT';

/**
 * This package's only error. Redis's own failures come back as they are,
 * from Bun's client; this is for what *this* package decides.
 */
export class RedisError extends Error {
	readonly code: RedisErrorCode;
	/** The key or channel it happened on, without any value. */
	readonly key: string;

	/**
	 * `key` is empty for the failures that are about the connection rather
	 * than one key: `CONNECTION` and `PING_TIMEOUT`. It is never the URI — a
	 * connection string holds the password, and this package prints none.
	 */
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

/** What went wrong. Each one is documented in the README's Traps. */
export type S3ErrorCode =
	/** The body's content type is not one this bucket accepts. */
	| 'WRONG_TYPE'
	/** The body is bigger than this bucket's `maxSize`. */
	| 'TOO_LARGE'
	/** The body's size cannot be known before sending, and `maxSize` is set. */
	| 'UNMEASURABLE'
	/**
	 * An option's own value is not one the service accepts: `acl` or
	 * `storageClass` on a write, `acl` or `expiresIn` on a presigned URL.
	 */
	| 'WRONG_OPTION';

/**
 * This package's only error, and every one of them is thrown **before**
 * anything is sent. S3's own failures come back as they are, from Bun's
 * client.
 */
export class S3Error extends Error {
	readonly code: S3ErrorCode;
	/** The object key it was about — the bucket and the key, never the body. */
	readonly key: string;

	constructor(code: S3ErrorCode, key: string, message: string) {
		super(message);
		this.name = 'S3Error';
		this.code = code;
		this.key = key;
	}
}

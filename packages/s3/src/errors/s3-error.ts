/**
 * What went wrong. Each one is in the README's Errors table, and each
 * message it carries has an entry in `docs/troubleshooting.md`, headed by its
 * text.
 */
export type S3ErrorCode =
	/**
	 * The content type is not one this bucket accepts, or none was named where
	 * the bucket names some — on `put` and on `presignPost`, which also
	 * refuses a `{ startsWith }` prefix on a bucket that names its types.
	 */
	| 'WRONG_TYPE'
	/** The body is bigger than this bucket's `maxSize`. */
	| 'TOO_LARGE'
	/** The body's size cannot be known before sending, and `maxSize` is set. */
	| 'UNMEASURABLE'
	/**
	 * An option's own value is not one the service accepts: `acl` or
	 * `storageClass` on a write; `acl` or `expiresIn` on `presignGet`,
	 * `presignPut` and `presignPost`; and on `presignPost`, a `maxSize` or
	 * `minSize` that is not a whole number of bytes, a `maxSize` above the
	 * bucket's own or missing on a bucket without one, a `minSize` above the
	 * `maxSize`, or a `type` that is neither a string nor `{ startsWith }`.
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

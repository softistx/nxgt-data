/**
 * Codes that mean the bucket cannot be used from here, rather than that the
 * request was wrong: Bun and Node network failures, this package's own
 * `TIMEOUT`, and the S3 service codes Bun's client surfaces for a
 * deployment problem (credentials, missing bucket, an unhealthy or throttling
 * service). `NoSuchKey` and the other per-request codes are not in it.
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
	// this package's only code raised after a request was sent
	'TIMEOUT',
	// Bun and Node network failures
	'ConnectionRefused',
	'ConnectionClosed',
	'DNSResolveFailed',
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EPIPE',
	// S3 service codes: the deployment cannot use the bucket
	'AccessDenied',
	'InvalidAccessKeyId',
	'SignatureDoesNotMatch',
	'NoSuchBucket',
	'ExpiredToken',
	'InternalError',
	'ServiceUnavailable',
	'SlowDown',
]);

/**
 * Whether a failure means the bucket is unavailable, so a route can answer
 * 503. Reads the `code` of an `Error` only, never its name or message.
 *
 * `true` for: this package's `S3Error` with code `TIMEOUT`; a Bun or Node
 * network code (`ConnectionRefused`, `ECONNREFUSED`, `ETIMEDOUT`, …); and an
 * S3 service code meaning the deployment cannot use the bucket
 * (`AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`,
 * `NoSuchBucket`, `ExpiredToken`, `InternalError`, `ServiceUnavailable`,
 * `SlowDown`).
 *
 * `false` for this package's refusals of the caller's input (`WRONG_TYPE`,
 * `TOO_LARGE`, `UNMEASURABLE`, `WRONG_OPTION`), which stay the caller's
 * (4xx); for per-request codes such as `NoSuchKey`; and for anything that is
 * not an `Error` with a string `code`.
 */
export function isBucketUnavailable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const { code } = error as { code?: unknown };
	return typeof code === 'string' && UNAVAILABLE_CODES.has(code);
}

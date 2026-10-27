import { S3Error } from './s3-error';

/** Bun and Node codes that mean the service could not be reached. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
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
]);

/**
 * Whether a failure means the bucket is unavailable: any `S3Error` of this
 * package, or an `Error` whose `code` is a Bun or Node network code. Reads
 * the `code` only, never the message.
 */
export function isBucketUnavailable(error: unknown): boolean {
	if (error instanceof S3Error) return true;
	if (!(error instanceof Error)) return false;
	const { code } = error as { code?: unknown };
	return typeof code === 'string' && NETWORK_CODES.has(code);
}

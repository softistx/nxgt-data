import { describe, expect, test } from 'bun:test';
import { isBucketUnavailable } from './is-bucket-unavailable';
import { S3Error, type S3ErrorCode } from './s3-error';

const withCode = (code: unknown, message = 'boom') =>
	Object.assign(new Error(message), { code });

describe('isBucketUnavailable', () => {
	test("is true for this package's TIMEOUT", () => {
		expect(isBucketUnavailable(new S3Error('TIMEOUT', 'k', 'late'))).toBe(true);
	});

	test.each([
		'WRONG_TYPE',
		'TOO_LARGE',
		'UNMEASURABLE',
		'WRONG_OPTION',
	] as const)("is false for the caller's refusal %s", (code) => {
		expect(isBucketUnavailable(new S3Error(code, 'k', 'refused'))).toBe(false);
	});

	test('is false for every S3ErrorCode except TIMEOUT', () => {
		const codes: Record<S3ErrorCode, true> = {
			WRONG_TYPE: true,
			TOO_LARGE: true,
			UNMEASURABLE: true,
			WRONG_OPTION: true,
			TIMEOUT: true,
		};
		for (const code of Object.keys(codes) as S3ErrorCode[]) {
			expect(isBucketUnavailable(new S3Error(code, 'k', 'x'))).toBe(
				code === 'TIMEOUT',
			);
		}
	});

	test.each([
		'AccessDenied',
		'InvalidAccessKeyId',
		'SignatureDoesNotMatch',
		'NoSuchBucket',
		'ExpiredToken',
		'InternalError',
		'ServiceUnavailable',
		'SlowDown',
	])('is true for the service code %s on a native error', (code) => {
		expect(isBucketUnavailable(withCode(code))).toBe(true);
	});

	test.each(['NoSuchKey', 'UnknownError', 'NotFound'])(
		'is false for the per-request code %s',
		(code) => {
			expect(isBucketUnavailable(withCode(code))).toBe(false);
		},
	);

	test.each([
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
	])('is true for an Error with code %s', (code) => {
		expect(isBucketUnavailable(withCode(code))).toBe(true);
	});

	test('reads the code only, never the message', () => {
		expect(isBucketUnavailable(new Error('ECONNREFUSED at 127.0.0.1'))).toBe(
			false,
		);
		expect(isBucketUnavailable(withCode('EACCES', 'ECONNREFUSED'))).toBe(false);
	});

	test('is false for other errors and non-errors', () => {
		expect(isBucketUnavailable(new TypeError('x'))).toBe(false);
		expect(isBucketUnavailable(withCode(undefined))).toBe(false);
		expect(isBucketUnavailable(withCode(42))).toBe(false);
		expect(isBucketUnavailable('ECONNREFUSED')).toBe(false);
		expect(isBucketUnavailable({ code: 'ECONNREFUSED' })).toBe(false);
		expect(isBucketUnavailable(null)).toBe(false);
		expect(isBucketUnavailable(undefined)).toBe(false);
	});
});

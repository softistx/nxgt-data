import { S3Error } from '../errors/s3-error';
import type { BucketContext } from './context';
import type { PutBody } from './types';

/**
 * A content type without its parameters, lower-cased: `text/plain` from
 * `text/plain;charset=utf-8`.
 *
 * Both sides of the comparison go through this, because the type a body
 * carries is rarely the bare one a definition names — `Bun.file('a.json')`
 * reports `application/json;charset=utf-8` (measured on bun 1.4.2), and an
 * explicit `IMAGE/PNG` is the same type as `image/png`.
 */
export function essenceOf(type: string): string {
	return (type.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The type a write would carry: the one the caller named, or the one the
 * body knows about itself. One function, so the type `check` approves and
 * the type `put` sends can never be two different answers.
 */
export function effectiveType(
	body: PutBody,
	named: string | undefined,
): string | undefined {
	// A Blob carries its own type; anything else has to be told.
	return named ?? (body instanceof Blob ? body.type || undefined : undefined);
}

/** The body's size, or `undefined` when it cannot be known before sending. */
export function sizeOf(body: PutBody): number | undefined {
	if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
	// An `S3File` **is** a `Blob` — measured on bun 1.4.2 — and its `size` is
	// `NaN`, because nothing has asked the service yet. Returning that would
	// pass the guard silently: `NaN > maxSize` is false, whatever `maxSize` is.
	if (body instanceof Blob) {
		return Number.isFinite(body.size) ? body.size : undefined;
	}
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	// A stream, a `Response`: nothing says how long it is until it has been
	// read, which is what `UNMEASURABLE` is about.
	return undefined;
}

/** Refuses a type the bucket does not accept. Shared by `put` and `presign`. */
export function checkType<P>(
	context: BucketContext<P>,
	key: string,
	type: string | undefined,
): void {
	const { accepted } = context;
	if (!accepted) return;
	const list = accepted.join(', ');
	if (!type) {
		throw new S3Error(
			'WRONG_TYPE',
			key,
			`"${context.definition.bucket}" accepts ${list}, and this write ` +
				'names no content type. Pass `type`',
		);
	}
	if (!accepted.some((one) => essenceOf(one) === essenceOf(type))) {
		throw new S3Error(
			'WRONG_TYPE',
			key,
			`"${context.definition.bucket}" accepts ${list}, not ${type}`,
		);
	}
}

/** Refuses a body the bucket does not accept, before anything is sent. */
export function checkSize<P>(
	context: BucketContext<P>,
	key: string,
	body: PutBody,
): void {
	const { maxSize, bucket } = context.definition;
	if (maxSize === undefined) return;
	const size = sizeOf(body);
	if (size === undefined) {
		throw new S3Error(
			'UNMEASURABLE',
			key,
			`"${bucket}" has a maxSize, and this body's size cannot be known ` +
				'before sending it. Read it into memory first, or drop `maxSize` ' +
				'and let the service refuse it',
		);
	}
	if (size > maxSize) {
		throw new S3Error(
			'TOO_LARGE',
			key,
			`"${bucket}" accepts ${maxSize} bytes at most, and this body is ${size}`,
		);
	}
}

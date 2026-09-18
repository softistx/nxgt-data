import type { S3Options } from 'bun';
import { type BucketContext, keyOf } from '../context';

/** How a presigned URL is asked for. `expiresIn` is **seconds**, as S3's is. */
export interface PresignOptions {
	/** Seconds until it expires. Bun's default is a day; give one. */
	expiresIn?: number;
	/** `public-read` and the rest, when the service honours it. */
	acl?: S3Options['acl'];
}

export function presignGetUrl<P>(
	context: BucketContext<P>,
	params: P,
	options?: PresignOptions,
): string {
	return context.client.presign(keyOf(context, params), {
		...options,
		method: 'GET',
	});
}

/**
 * A URL that writes this object, signed.
 *
 * It carries **no content type**, and takes none. Measured on bun 1.4.2:
 * `presign`'s `type` only adds `response-content-type`, S3's override for
 * what a *download* is labelled; `X-Amz-SignedHeaders` stays `host`, so the
 * `Content-Type` the uploader sends is not signed and not constrained. A PUT
 * signed for a `text/csv` bucket stores an `application/zip` body happily —
 * measured against this package's own test service, status 200. Naming a type
 * here would only look like a guarantee.
 */
export function presignPutUrl<P>(
	context: BucketContext<P>,
	params: P,
	options?: PresignOptions,
): string {
	return context.client.presign(keyOf(context, params), {
		...options,
		method: 'PUT',
	});
}

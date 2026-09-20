import type { S3Options } from 'bun';
import { type BucketContext, keyOf } from '../context';
import { checkOption } from '../guards';

/** How a presigned URL is asked for. `expiresIn` is **seconds**, as S3's is. */
export interface PresignOptions {
	/** Seconds until it expires. Bun's default is a day; give one. */
	expiresIn?: number;
	/** `public-read` and the rest, when the service honours it. */
	acl?: S3Options['acl'];
}

/**
 * The options this package signs with, and only those.
 *
 * The same rule as a write's, for the same measured reason: Bun's second
 * parameter extends `S3Options`, so a value carrying extra keys at run time —
 * an options bag off a request body, anything that is not a fresh object
 * literal — **redirects the signed URL**. Measured: a `bucket` key signs a
 * URL for another bucket, and a credential key signs it against another
 * endpoint entirely. The types refuse both; a value that never met the types
 * does not.
 */
const SIGNED = ['expiresIn', 'acl'] as const satisfies readonly Signable[];

type Signable = keyof PresignOptions;
type Unsigned = Exclude<Signable, (typeof SIGNED)[number]>;
const _nothingForgotten: [Unsigned] extends [never] ? true : Unsigned = true;
void _nothingForgotten;

function signed(
	key: string,
	options: PresignOptions | undefined,
): PresignOptions {
	const forwarded: Record<string, unknown> = {};
	for (const name of SIGNED) {
		const value = options?.[name];
		if (value === undefined) continue;
		// The same allowlist a `put` is held to: a wrong `acl` is an `S3Error`
		// with `WRONG_OPTION` whichever of the two a caller reached for, rather
		// than an `S3Error` here and Bun's own `TypeError` there.
		checkOption(key, name, value);
		forwarded[name] = value;
	}
	return forwarded as PresignOptions;
}

export function presignGetUrl<P>(
	context: BucketContext<P>,
	params: P,
	options?: PresignOptions,
): string {
	const key = keyOf(context, params);
	return context.client.presign(key, {
		...signed(key, options),
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
	const key = keyOf(context, params);
	return context.client.presign(key, {
		...signed(key, options),
		method: 'PUT',
	});
}

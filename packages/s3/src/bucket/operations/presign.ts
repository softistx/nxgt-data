import type { S3Options } from 'bun';
import { type BucketContext, callOf, keyOf } from '../context';
import { checkOption } from '../guards';

/** How a presigned URL is asked for. `expiresIn` is **seconds**, as S3's is. */
export interface PresignOptions {
	/** Seconds until it expires. Bun's default is a day; give one. */
	expiresIn?: number | undefined;
	/** `public-read` and the rest, when the service honours it. */
	acl?: S3Options['acl'];
}

/** What a signed GET may add: how the download is presented. */
export interface PresignGetOptions extends PresignOptions {
	/**
	 * Signs `response-content-disposition`: the service answers this URL with
	 * that `Content-Disposition`, whatever the object stored. A download link
	 * with a filename: `attachment; filename*=UTF-8''report.pdf`. Printable
	 * ASCII only. A `presignPut` takes none: the header would mean nothing
	 * to a write.
	 */
	contentDisposition?: string | undefined;
}

/** What is signed: the options a caller gave, none of them `undefined`. */
type Signed<O> = {
	[K in keyof O]?: Exclude<O[K], undefined>;
};

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
const SIGNED_PUT = [
	'expiresIn',
	'acl',
] as const satisfies readonly (keyof PresignOptions)[];

/** A GET signs the same, and `contentDisposition` besides. */
const SIGNED_GET = [
	'expiresIn',
	'acl',
	'contentDisposition',
] as const satisfies readonly (keyof PresignGetOptions)[];

type UnsignedPut = Exclude<keyof PresignOptions, (typeof SIGNED_PUT)[number]>;
const _putForgotten: [UnsignedPut] extends [never] ? true : UnsignedPut = true;
void _putForgotten;

type UnsignedGet = Exclude<
	keyof PresignGetOptions,
	(typeof SIGNED_GET)[number]
>;
const _getForgotten: [UnsignedGet] extends [never] ? true : UnsignedGet = true;
void _getForgotten;

function signed<O extends PresignOptions>(
	key: string,
	options: O | undefined,
	names: readonly (keyof O & string)[],
	where: string,
): Signed<O> {
	const forwarded: Record<string, unknown> = {};
	for (const name of names) {
		const value = options?.[name];
		if (value === undefined) continue;
		// The same allowlist a `put` is held to: a wrong `acl` is an `S3Error`
		// with `WRONG_OPTION` whichever of the two a caller reached for, rather
		// than an `S3Error` here and Bun's own `TypeError` there.
		checkOption(key, name, value, where);
		forwarded[name] = value;
	}
	return forwarded as Signed<O>;
}

export function presignGetUrl<P>(
	context: BucketContext<P>,
	params: P,
	options?: PresignGetOptions,
): string {
	const key = keyOf(context, params);
	return context.presignClient.presign(key, {
		...signed(key, options, SIGNED_GET, callOf(context, 'presignGet')),
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
	return context.presignClient.presign(key, {
		...signed(key, options, SIGNED_PUT, callOf(context, 'presignPut')),
		method: 'PUT',
	});
}

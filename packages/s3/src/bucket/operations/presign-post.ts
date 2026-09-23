import type { S3Options } from 'bun';
import { S3Error } from '../../errors/s3-error';
import { type BucketContext, keyOf } from '../context';
import { checkOption, checkType } from '../guards';
import {
	type PolicyCondition,
	type PostSigner,
	type PresignedPost,
	signPostPolicy,
} from './post-policy';

export type { PresignedPost };

/**
 * How a presigned POST is asked for. Every bound here is one the **service**
 * holds the upload to — measured against SeaweedFS 4.47, a body over
 * `maxSize` is refused with `400 EntityTooLarge` and a wrong type with
 * `403 AccessDenied`.
 */
export interface PresignPostOptions {
	/** Seconds until the form expires: 1 to 604800. A day when left out. */
	expiresIn?: number;
	/**
	 * The biggest body, in bytes. Defaults to the bucket's own `maxSize`, and
	 * cannot be above it; a bucket without one requires it.
	 */
	maxSize?: number;
	/** The smallest body, in bytes. `0` when left out. */
	minSize?: number;
	/**
	 * The one content type the form may carry, or a prefix of it. Defaults to
	 * the bucket's `contentType` when that is a single type. A prefix is for
	 * a bucket that names no type: the browser then sets `Content-Type`.
	 */
	type?: string | { startsWith: string };
	/** `public-read` and the rest, fixed by the policy. */
	acl?: S3Options['acl'];
}

/** Bun's own default for a presigned URL, a day, so all three agree. */
const DEFAULT_EXPIRES_IN = 86_400;

/**
 * A value's shape, for a message: an option can come off a request body,
 * and a message reports what it was, never what it held.
 */
function shapeOf(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	if (typeof value === 'number') {
		if (Number.isNaN(value)) return 'NaN';
		if (!Number.isFinite(value)) return 'an infinite number';
		if (!Number.isInteger(value)) return 'a fraction';
		if (value === 0) return 'zero';
		if (value < 0) return 'a negative number';
		return Number.isSafeInteger(value) ? 'a number' : 'a number too large';
	}
	return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** All a message needs of the context: which bucket it was about. */
type Named = { readonly definition: { readonly bucket: string } };

const callOn = (context: Named) =>
	`presignPost on "${context.definition.bucket}"`;

function checkBytes(
	context: Named,
	key: string,
	name: 'maxSize' | 'minSize',
	value: unknown,
	least: number,
): asserts value is number {
	if (typeof value === 'number' && Number.isSafeInteger(value)) {
		if (value >= least) return;
	}
	throw new S3Error(
		'WRONG_OPTION',
		key,
		`${callOn(context)}: ${name} is a whole number of bytes, at least ` +
			`${least}; got ${shapeOf(value)}`,
	);
}

/** `content-length-range`, which is the point of a POST over a PUT. */
function sizeRange<P>(
	context: BucketContext<P>,
	key: string,
	options: PresignPostOptions | undefined,
): PolicyCondition {
	const bound = context.definition.maxSize;
	const max = options?.maxSize ?? bound;
	if (max === undefined) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`${callOn(context)}: this bucket has no maxSize, and a presigned POST ` +
				'is a bound on what a browser uploads. Pass `maxSize`, in bytes',
		);
	}
	checkBytes(context, key, 'maxSize', max, 1);
	if (bound !== undefined && max > bound) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`${callOn(context)}: maxSize cannot be above the bucket's own ` +
				`${bound} bytes; got a larger number`,
		);
	}
	const min = options?.minSize ?? 0;
	checkBytes(context, key, 'minSize', min, 0);
	if (min > max) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`${callOn(context)}: minSize is above maxSize, so no body could be posted`,
		);
	}
	return ['content-length-range', min, max];
}

/** Either a `Content-Type` field fixed by `eq`, or a `starts-with`. */
type TypeRule = { field: string } | { condition: PolicyCondition };

function isPrefix(type: unknown): type is { startsWith: string } {
	return (
		typeof type === 'object' &&
		type !== null &&
		typeof (type as { startsWith?: unknown }).startsWith === 'string'
	);
}

function typeRule<P>(
	context: BucketContext<P>,
	key: string,
	type: unknown,
): TypeRule {
	const { accepted } = context;
	if (type === undefined) {
		// A browser may set its own type only when a condition names it.
		if (!accepted) return { condition: ['starts-with', '$Content-Type', ''] };
		if (accepted.length === 1) return { field: accepted[0] as string };
		checkType(context, key, undefined, 'presignPost');
	}
	if (typeof type === 'string' && type.length > 0) {
		checkType(context, key, type, 'presignPost');
		return { field: type };
	}
	if (isPrefix(type)) {
		if (accepted) {
			throw new S3Error(
				'WRONG_TYPE',
				key,
				`${callOn(context)}: this bucket accepts ${accepted.join(', ')}, ` +
					'and a prefix would let another type through. Pass one of them ' +
					'as `type`',
			);
		}
		return {
			condition: ['starts-with', '$Content-Type', type.startsWith],
		};
	}
	throw new S3Error(
		'WRONG_OPTION',
		key,
		`${callOn(context)}: type is a content type ` +
			`or { startsWith }; got ${shapeOf(type)}`,
	);
}

/**
 * Where Bun would send this bucket's requests, and as whom.
 *
 * Read off a URL Bun itself signs, rather than worked out again here:
 * measured on bun 1.4.2, Bun signs for region `auto` at any endpoint that is
 * not AWS's, reads the region out of an AWS hostname, falls back to
 * `us-east-1`, and puts the bucket in the path or the host by
 * `virtualHostedStyle`. A second copy of those rules would drift from the
 * first; this way a POST goes wherever a presigned PUT goes. The probe key is
 * signed and thrown away — nothing is sent.
 */
const PROBE = 'nxgt-probe';

function signerOf<P>(context: BucketContext<P>): PostSigner {
	const probe = new URL(
		context.client.presign(PROBE, { method: 'PUT', expiresIn: 1 }),
	);
	const scope = (probe.searchParams.get('X-Amz-Credential') ?? '').split('/');
	const { secretAccessKey } = context;
	if (scope.length < 5 || !secretAccessKey) {
		throw new TypeError(
			`${callOn(context)}: no secret access key ` +
				'to sign with. Pass `secretAccessKey` to bindBucket, or set ' +
				'S3_SECRET_ACCESS_KEY',
		);
	}
	return {
		url: `${probe.origin}${probe.pathname.slice(0, -PROBE.length)}`,
		bucket: context.definition.bucket,
		accessKeyId: scope.slice(0, -4).join('/'),
		region: scope.at(-3) as string,
		secretAccessKey,
		sessionToken: probe.searchParams.get('X-Amz-Security-Token') ?? undefined,
	};
}

/**
 * The form a browser posts to upload this object: the key fixed, the size
 * held to a range, the content type fixed or held to a prefix — all by the
 * service. `now` is for the spec; a caller never passes it.
 */
export function presignPostForm<P>(
	context: BucketContext<P>,
	params: P,
	options?: PresignPostOptions,
	now: Date = new Date(),
): PresignedPost {
	const key = keyOf(context, params);
	const expiresIn = options?.expiresIn ?? DEFAULT_EXPIRES_IN;
	checkOption(key, 'expiresIn', expiresIn);
	const range = sizeRange(context, key, options);
	const rule = typeRule(context, key, options?.type);
	const fields: Record<string, string> = { key };
	if ('field' in rule) fields['Content-Type'] = rule.field;
	if (options?.acl !== undefined) {
		checkOption(key, 'acl', options.acl);
		fields.acl = options.acl;
	}
	return signPostPolicy(signerOf(context), {
		fields,
		conditions: 'condition' in rule ? [range, rule.condition] : [range],
		expiresIn,
		now,
	});
}

import type { S3Options } from 'bun';
import { S3Error } from '../../errors/s3-error';
import { type BucketContext, callOf, keyOf } from '../context';
import { checkOption, checkType } from '../guards';
import { shapeOf } from '../shape';
import {
	type PolicyCondition,
	type PresignedPost,
	signPostPolicy,
} from './post-policy';
import { signerOf } from './post-signer';

export type { PresignedPost };

/**
 * How a presigned POST is asked for. Every bound here is one the **service**
 * holds the upload to — measured against SeaweedFS 4.47, a body over
 * `maxSize` is refused with `400 EntityTooLarge` and a wrong type with
 * `403 AccessDenied`.
 */
export interface PresignPostOptions {
	/** Seconds until the form expires: above 0, at most 604800. A day when left out. */
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
	 * a bucket that names no type: the page's code then appends its own
	 * `Content-Type` field before the file.
	 */
	type?: string | { startsWith: string };
	/** `public-read` and the rest, fixed by the policy. */
	acl?: S3Options['acl'];
}

/** Bun's own default for a presigned URL, a day, so all three agree. */
const DEFAULT_EXPIRES_IN = 86_400;

const callOn = <P>(context: BucketContext<P>) => callOf(context, 'presignPost');

function checkBytes<P>(
	context: BucketContext<P>,
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
		checkType(context, key, undefined, callOn(context));
	}
	if (typeof type === 'string' && type.length > 0) {
		checkType(context, key, type, callOn(context));
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
	checkOption(key, 'expiresIn', expiresIn, callOn(context));
	const range = sizeRange(context, key, options);
	const rule = typeRule(context, key, options?.type);
	const fields: Record<string, string> = { key };
	if ('field' in rule) fields['Content-Type'] = rule.field;
	if (options?.acl !== undefined) {
		checkOption(key, 'acl', options.acl, callOn(context));
		fields.acl = options.acl;
	}
	return signPostPolicy(signerOf(context), {
		fields,
		conditions: 'condition' in rule ? [range, rule.condition] : [range],
		expiresIn,
		now,
	});
}

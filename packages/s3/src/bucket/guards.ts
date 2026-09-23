import { S3Error } from '../errors/s3-error';
import type { BucketContext } from './context';
import type { PresignOptions } from './operations/presign';
import { shapeOf } from './shape';
import type { PutBody, PutOptions } from './types';

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

/** ` (presignPost)`: the call, after the searchable lead. Nothing for `put`. */
const named = (where: string | undefined) => (where ? ` (${where})` : '');

/**
 * Refuses a type the bucket does not accept. Shared by `put` and
 * `presignPost`; `where` names the call when it is not `put`, after the
 * searchable lead, so the same refusal reads the same in a log. The type
 * itself is never quoted: for a presigned POST it came off a request.
 */
export function checkType<P>(
	context: BucketContext<P>,
	key: string,
	type: string | undefined,
	where?: string,
): void {
	const { accepted } = context;
	if (!accepted) return;
	const list = accepted.join(', ');
	const suffix = named(where);
	if (!type) {
		throw new S3Error(
			'WRONG_TYPE',
			key,
			`"${context.definition.bucket}" accepts ${list}, and no content type ` +
				`was named. Pass \`type\`${suffix}`,
		);
	}
	if (!accepted.some((one) => essenceOf(one) === essenceOf(type))) {
		throw new S3Error(
			'WRONG_TYPE',
			key,
			`"${context.definition.bucket}" accepts ${list}, not the type given${suffix}`,
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

/**
 * The values the service accepts for the two options that have a fixed set,
 * listed so this package refuses a wrong one itself.
 *
 * Bun checks them too, and refuses with a plain `TypeError` — measured on
 * bun 1.4.2, `name` is `"TypeError"`. Every other refusal of the same call
 * is an `S3Error` with a code, so a caller had to catch two classes for one
 * `put`, and read message text for one of them. Checking here gives every
 * refusal of a write one class and one code.
 *
 * The exhaustiveness lines below are the ones `PASSED` carries in `writes.ts`,
 * for the values rather than the keys: a value Bun adds or drops fails the
 * build here instead of silently widening or narrowing what this package
 * accepts.
 */
const ACLS = [
	'private',
	'public-read',
	'public-read-write',
	'aws-exec-read',
	'authenticated-read',
	'bucket-owner-read',
	'bucket-owner-full-control',
	'log-delivery-write',
] as const satisfies readonly NonNullable<PutOptions['acl']>[];

const STORAGE_CLASSES = [
	'STANDARD',
	'DEEP_ARCHIVE',
	'EXPRESS_ONEZONE',
	'GLACIER',
	'GLACIER_IR',
	'INTELLIGENT_TIERING',
	'ONEZONE_IA',
	'OUTPOSTS',
	'REDUCED_REDUNDANCY',
	'SNOW',
	'STANDARD_IA',
] as const satisfies readonly NonNullable<PutOptions['storageClass']>[];

type UnlistedAcl = Exclude<
	NonNullable<PutOptions['acl']>,
	(typeof ACLS)[number]
>;
const _everyAclListed: [UnlistedAcl] extends [never] ? true : UnlistedAcl =
	true;
void _everyAclListed;

type UnlistedClass = Exclude<
	NonNullable<PutOptions['storageClass']>,
	(typeof STORAGE_CLASSES)[number]
>;
const _everyClassListed: [UnlistedClass] extends [never]
	? true
	: UnlistedClass = true;
void _everyClassListed;

const ALLOWED = {
	acl: ACLS,
	storageClass: STORAGE_CLASSES,
} as const satisfies Partial<
	Record<keyof PutOptions | keyof PresignOptions, readonly string[]>
>;

/**
 * The longest a presigned URL can live: SigV4's own limit, seven days.
 *
 * Measured on bun 1.4.2: the client refuses `0` and below with a `TypeError`
 * of its own, and **signs** an `expiresIn` of `1e12` happily — a URL the
 * service then rejects at use time, which is the one thing this package
 * exists not to do.
 */
const MAX_EXPIRES_IN = 604_800;

/**
 * Refuses a value the service does not accept for `acl` or `storageClass`.
 * Shared by `put` and the three presigned calls, so the same wrong `acl` is
 * the same error whichever one a caller reached for; `where` names the call
 * when it is not `put`. An option with no fixed set passes. The value is
 * reported by its shape, never quoted.
 */
export function checkOption(
	key: string,
	name: string,
	value: unknown,
	where?: string,
): void {
	if (value === undefined) return;
	if (name === 'expiresIn') {
		checkExpiresIn(key, value, where);
		return;
	}
	const allowed = (ALLOWED as Record<string, readonly string[] | undefined>)[
		name
	];
	if (!allowed) return;
	if (!allowed.includes(value as string)) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`${name} must be one of ${allowed.join(', ')}; got ` +
				`${typeof value === 'string' ? 'another string' : shapeOf(value)}` +
				named(where),
		);
	}
}

function checkExpiresIn(key: string, value: unknown, where?: string): void {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > MAX_EXPIRES_IN
	) {
		throw new S3Error(
			'WRONG_OPTION',
			key,
			`expiresIn is seconds, and must be above 0 and at most ` +
				`${MAX_EXPIRES_IN} (seven days, which is S3's own limit); ` +
				`got ${tooLong(value) ? 'a number above that' : shapeOf(value)}` +
				named(where),
		);
	}
}

const tooLong = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value > MAX_EXPIRES_IN;

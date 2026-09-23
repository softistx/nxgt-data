import type { S3Client } from 'bun';
import type { BucketDefinition } from './types';

/**
 * What every operation of a bound bucket works from, resolved once: the
 * client, the definition, and the accepted content types as a list.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `guards.ts` and `operations/` — a context of
 * closures would only be the factory this package split up, one size down.
 *
 * It holds no secret either: see `secretOf`.
 */
export interface BucketContext<P> {
	readonly client: S3Client;
	readonly definition: BucketDefinition<P>;
	/**
	 * The types the definition accepts, always as a list, **as written** —
	 * an error message quotes these, and the comparison normalises them.
	 * `undefined` when the bucket accepts anything.
	 */
	readonly accepted: readonly string[] | undefined;
}

/**
 * The secret a presigned POST signs its policy with, per context.
 *
 * Bun's client keeps its own and never hands it back — measured, neither
 * `Bun.inspect` nor `JSON.stringify` of an `S3Client` shows it — and a POST
 * policy is the one signature Bun does not make. So it is kept here, beside
 * the context rather than on it: a field on the context is printed by
 * `Bun.inspect(context)` and `JSON.stringify(context)` alike, which is
 * exactly how a secret reaches a log.
 */
const secrets = new WeakMap<object, string>();

/** The secret this context signs with, or `undefined` when there is none. */
export function secretOf<P>(context: BucketContext<P>): string | undefined {
	return secrets.get(context);
}

/** The types a definition accepts, as a list. */
function acceptedTypes(
	contentType: string | readonly string[] | undefined,
): readonly string[] | undefined {
	if (contentType === undefined) return undefined;
	return typeof contentType === 'string' ? [contentType] : contentType;
}

/**
 * The context of a bound bucket. The secret is resolved in the order Bun
 * documents — the option, then `S3_SECRET_ACCESS_KEY`, then
 * `AWS_SECRET_ACCESS_KEY` — but from the environment **as it is now**, while
 * Bun uses it as it was when the process started. The two can differ, which
 * is why `signerOf` checks this secret against Bun's own signature before
 * signing anything with it.
 */
export function bucketContext<P>(
	client: S3Client,
	definition: BucketDefinition<P>,
	secretAccessKey?: string,
): BucketContext<P> {
	const context: BucketContext<P> = {
		client,
		definition,
		accepted: acceptedTypes(definition.contentType),
	};
	const secret =
		secretAccessKey ||
		Bun.env.S3_SECRET_ACCESS_KEY ||
		Bun.env.AWS_SECRET_ACCESS_KEY;
	if (secret) secrets.set(context, secret);
	return context;
}

/**
 * `put on "avatars"`: the call a consumer wrote and the bucket it was on,
 * which every refusal names — a log line holding one says which of an
 * application's buckets, and which of its calls, produced it.
 */
export function callOf<P>(context: BucketContext<P>, call: string): string {
	return `${call} on "${context.definition.bucket}"`;
}

/** The key this definition builds for these parameters. */
export function keyOf<P>(context: BucketContext<P>, params: P): string {
	return context.definition.key(params);
}

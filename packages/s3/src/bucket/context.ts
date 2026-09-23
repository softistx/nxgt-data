import type { S3Client } from 'bun';
import type { BucketDefinition } from './types';

/**
 * What every operation of a bound bucket works from, resolved once: the
 * client, the definition, and the accepted content types as a list.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `guards.ts` and `operations/` — a context of
 * closures would only be the factory this package split up, one size down.
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
	/**
	 * The secret a presigned POST signs its policy with, resolved the way
	 * Bun documents it: the option, then `S3_SECRET_ACCESS_KEY`, then
	 * `AWS_SECRET_ACCESS_KEY`. Bun's client keeps it and never hands it back,
	 * and a POST policy is the one signature Bun does not make — so it is
	 * kept here too. `undefined` when there is none.
	 */
	readonly secretAccessKey: string | undefined;
}

/** The types a definition accepts, as a list. */
function acceptedTypes(
	contentType: string | readonly string[] | undefined,
): readonly string[] | undefined {
	if (contentType === undefined) return undefined;
	return typeof contentType === 'string' ? [contentType] : contentType;
}

export function bucketContext<P>(
	client: S3Client,
	definition: BucketDefinition<P>,
	secretAccessKey?: string,
): BucketContext<P> {
	return {
		client,
		definition,
		accepted: acceptedTypes(definition.contentType),
		secretAccessKey:
			secretAccessKey ||
			Bun.env.S3_SECRET_ACCESS_KEY ||
			Bun.env.AWS_SECRET_ACCESS_KEY ||
			undefined,
	};
}

/** The key this definition builds for these parameters. */
export function keyOf<P>(context: BucketContext<P>, params: P): string {
	return context.definition.key(params);
}

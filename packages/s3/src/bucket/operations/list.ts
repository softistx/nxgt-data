import type { S3ListObjectsOptions, S3ListObjectsResponse } from 'bun';
import type { BucketContext } from '../context';
import type { ObjectPage, StoredObject } from '../types';

/** One page of the bucket, in this repository's cursor shape. */
export async function listObjects<P>(
	context: BucketContext<P>,
	options: { prefix?: string; limit?: number; cursor?: string | null } = {},
): Promise<ObjectPage> {
	const request: S3ListObjectsOptions = {};
	if (options.prefix !== undefined) request.prefix = options.prefix;
	if (options.limit !== undefined) request.maxKeys = options.limit;
	if (options.cursor != null) request.continuationToken = options.cursor;
	const answer = await context.client.list(request);
	const contents: NonNullable<S3ListObjectsResponse['contents']> =
		answer.contents ?? [];
	const items: StoredObject[] = contents.map((found) => ({
		key: found.key,
		size: found.size,
		lastModified: found.lastModified ? new Date(found.lastModified) : undefined,
		eTag: found.eTag,
	}));
	// `isTruncated` is what says there is more, and it is the only thing that
	// does: a service that sends a token on the last page anyway would page
	// for ever if the token alone decided. `null` is this repository's
	// "no next page".
	const next = answer.isTruncated
		? (answer.nextContinuationToken ?? null)
		: null;
	return { items, nextCursor: next };
}

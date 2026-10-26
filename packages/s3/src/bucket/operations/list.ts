import type { S3ListObjectsOptions, S3ListObjectsResponse } from 'bun';
import type { BucketContext } from '../context';
import type { CallOptions, ObjectPage, StoredObject } from '../types';
import { deadlineOf, withDeadline } from './deadline';
import { getListing } from './fetch-object';
import { type ListAnswer, parseListing } from './list-xml';
import { signerOf } from './post-signer';
import { signedBucketGet } from './query-sign';

type ListOptions = {
	prefix?: string;
	limit?: number;
	cursor?: string | null;
} & CallOptions;

/** One page of the bucket, in this repository's cursor shape. */
export async function listObjects<P>(
	context: BucketContext<P>,
	options: ListOptions = {},
): Promise<ObjectPage> {
	const timeoutMs = deadlineOf(context, '', 'list', options);
	if (timeoutMs === undefined) return pageOf(await viaBun(context, options));
	// Bun's `list` ignores a signal like the rest of its calls, so a listing
	// under a deadline is a GET this package signs itself (Bun cannot presign
	// a bucket-level request) and sends with `fetch`.
	const query: Record<string, string> = { 'list-type': '2' };
	if (options.prefix !== undefined) query['prefix'] = options.prefix;
	if (options.limit !== undefined) query['max-keys'] = String(options.limit);
	if (options.cursor != null) query['continuation-token'] = options.cursor;
	const url = signedBucketGet(signerOf(context, 'list'), query);
	return withDeadline(context, '', 'list', timeoutMs, async (signal) =>
		pageOf(parseListing(await getListing(context, url, signal))),
	);
}

async function viaBun<P>(
	context: BucketContext<P>,
	options: ListOptions,
): Promise<ListAnswer> {
	const request: S3ListObjectsOptions = {};
	if (options.prefix !== undefined) request.prefix = options.prefix;
	if (options.limit !== undefined) request.maxKeys = options.limit;
	if (options.cursor != null) request.continuationToken = options.cursor;
	const answer = await context.client.list(request);
	const contents: NonNullable<S3ListObjectsResponse['contents']> =
		answer.contents ?? [];
	return {
		contents: contents.map((found) => ({
			key: found.key,
			size: found.size,
			lastModified: found.lastModified,
			eTag: found.eTag,
		})),
		isTruncated: answer.isTruncated === true,
		nextContinuationToken: answer.nextContinuationToken,
	};
}

/** Either path's answer as the page: one mapping, so the two cannot differ. */
function pageOf(answer: ListAnswer): ObjectPage {
	const items: StoredObject[] = answer.contents.map((found) => ({
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

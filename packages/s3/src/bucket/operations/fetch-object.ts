import type { S3Stats } from 'bun';
import type { BucketContext } from '../context';

type Verb = 'HEAD' | 'GET' | 'DELETE';

/**
 * Bun's own S3 calls ignore an `AbortSignal` (measured on 1.4.3: still
 * pending seconds after an abort against a socket that never answers), but
 * `fetch` honours one. So a call with a deadline signs a URL with Bun and
 * sends it with `fetch`.
 */
async function send<P>(
	context: BucketContext<P>,
	key: string,
	method: Verb,
	signal: AbortSignal,
): Promise<Response> {
	const url = context.client.presign(key, { method, expiresIn: 60 });
	try {
		return await fetch(url, { method, signal });
	} catch (reason) {
		if (signal.aborted) throw reason;
		// The signed URL is a credential; a connection error may quote it.
		throw new Error(
			`${method} failed: ${(reason as { code?: string }).code ?? 'the request could not be made'}`,
		);
	}
}

/** What Bun throws for a failed request: an `Error` named `S3Error`. */
async function failure(
	response: Response,
	method: Verb,
	key: string,
): Promise<Error> {
	// A HEAD has no body: Bun itself says only that it was unexpected.
	const body = method === 'HEAD' ? '' : await response.text();
	const field = (tag: string) =>
		new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1];
	const error = new Error(
		field('Message') ?? 'an unexpected error has occurred',
	) as Error & { code: string; path: string; status: number };
	error.name = 'S3Error';
	error.code = field('Code') ?? 'UnknownError';
	error.path = key;
	error.status = response.status;
	return error;
}

/** HEAD: the stats Bun gives, or `undefined` when there is no such object. */
export async function headObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<S3Stats | undefined> {
	const response = await send(context, key, 'HEAD', signal);
	if (response.status === 404) return undefined;
	if (!response.ok) throw await failure(response, 'HEAD', key);
	const { headers } = response;
	return {
		size: Number(headers.get('content-length') ?? 0),
		lastModified: new Date(headers.get('last-modified') ?? 0),
		etag: headers.get('etag') ?? '',
		type: headers.get('content-type') ?? '',
	};
}

/** GET: the response to read, or `undefined` when there is no such object. */
export async function getObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<Response | undefined> {
	const response = await send(context, key, 'GET', signal);
	if (response.ok) return response;
	const error = await failure(response, 'GET', key);
	if (
		response.status === 404 &&
		(error as { code?: string }).code === 'NoSuchKey'
	) {
		return undefined;
	}
	throw error;
}

/** DELETE: S3 answers the same for an object that was not there. */
export async function removeObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<void> {
	const response = await send(context, key, 'DELETE', signal);
	if (!response.ok) throw await failure(response, 'DELETE', key);
	await response.arrayBuffer();
}

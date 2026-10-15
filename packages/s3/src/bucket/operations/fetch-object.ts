import type { S3Stats } from 'bun';
import type { BucketContext } from '../context';

type Verb = 'HEAD' | 'GET' | 'DELETE';

/** What Bun names a failed connection, by what `fetch` calls it. */
const BUN_CODES: Record<string, string> = {
	ECONNREFUSED: 'ConnectionRefused',
	ConnectionRefused: 'ConnectionRefused',
	ECONNRESET: 'ConnectionClosed',
	ConnectionClosed: 'ConnectionClosed',
	EPIPE: 'ConnectionClosed',
	UND_ERR_SOCKET: 'ConnectionClosed',
};

/** An `Error` named `S3Error`, as Bun throws for a failed S3 request. */
function s3Error(code: string, key: string, message: string): Error {
	const error = new Error(message) as Error & { code: string; path: string };
	error.name = 'S3Error';
	error.code = code;
	error.path = key;
	return error;
}

type Exchange = {
	status: number;
	ok: boolean;
	headers: Headers;
	body: Uint8Array;
};

/**
 * Bun's own S3 calls ignore an `AbortSignal` (measured on 1.4.3: still
 * pending seconds after an abort against a socket that never answers), but
 * `fetch` honours one. So a call with a deadline signs a URL with Bun and
 * sends it with `fetch`, and reads the whole body inside the same `try`.
 *
 * The signed URL is a credential, and the runtime's connection errors carry
 * it in their `path` (measured: a reset mid-body on 1.4.3). So nothing of a
 * non-abort failure is kept: it is rethrown in the shape Bun gives the same
 * failure without a deadline — name `S3Error`, Bun's code, `path` the key.
 */
async function send<P>(
	context: BucketContext<P>,
	key: string,
	method: Verb,
	signal: AbortSignal,
): Promise<Exchange> {
	const url = context.client.presign(key, { method, expiresIn: 60 });
	try {
		const response = await fetch(url, { method, signal });
		const body =
			method === 'HEAD'
				? new Uint8Array()
				: new Uint8Array(await response.arrayBuffer());
		return {
			status: response.status,
			ok: response.ok,
			headers: response.headers,
			body,
		};
	} catch (reason) {
		if (signal.aborted) throw reason;
		const code = (reason as { code?: unknown }).code;
		throw s3Error(
			(typeof code === 'string' && BUN_CODES[code]) || 'ConnectionClosed',
			key,
			'an unexpected error has occurred',
		);
	}
}

/** What Bun throws for a failed request: an `Error` named `S3Error`. */
function failure(response: Exchange, method: Verb, key: string): Error {
	// A HEAD has no body: Bun itself says only that it was unexpected.
	const body = new TextDecoder().decode(response.body);
	const field = (tag: string) =>
		new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1];
	const error = s3Error(
		field('Code') ?? 'UnknownError',
		key,
		field('Message') ?? 'an unexpected error has occurred',
	) as Error & { status: number };
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
	if (!response.ok) throw failure(response, 'HEAD', key);
	const { headers } = response;
	return {
		size: Number(headers.get('content-length') ?? 0),
		lastModified: new Date(headers.get('last-modified') ?? 0),
		etag: headers.get('etag') ?? '',
		type: headers.get('content-type') ?? '',
	};
}

/** GET: the bytes, or `undefined` when there is no such object. */
export async function getObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	const response = await send(context, key, 'GET', signal);
	if (response.ok) return response.body;
	const error = failure(response, 'GET', key);
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
	if (!response.ok) throw failure(response, 'DELETE', key);
}

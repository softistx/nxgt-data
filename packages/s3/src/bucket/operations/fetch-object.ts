import type { S3Stats } from 'bun';
import type { BucketContext } from '../context';
import type { PutOptions } from '../types';

type Verb = 'HEAD' | 'GET' | 'DELETE' | 'PUT';

/** What Bun names a failed connection, by what `fetch` calls it. */
const BUN_CODES: Record<string, string> = {
	ECONNREFUSED: 'ConnectionRefused',
	ConnectionRefused: 'ConnectionRefused',
	ECONNRESET: 'ConnectionClosed',
	ConnectionClosed: 'ConnectionClosed',
	ENOTFOUND: 'DNSResolveFailed',
	DNSResolveFailed: 'DNSResolveFailed',
	EPIPE: 'ConnectionClosed',
	UND_ERR_SOCKET: 'ConnectionClosed',
};

/** An `Error` named `S3Error`, as Bun throws for a failed S3 request. */
export function s3Error(code: string, key: string, message: string): Error {
	const error = new Error(message) as Error & { code: string; path: string };
	error.name = 'S3Error';
	error.code = code;
	error.path = key;
	return error;
}

/**
 * What a call adds to the bare verb: a URL already signed (a listing's), or
 * the options Bun must **sign** into the query (a PUT's `acl` and
 * `storageClass`), a body and plain request headers.
 */
type Request = {
	url?: string;
	signed?: {
		acl?: NonNullable<PutOptions['acl']>;
		storageClass?: NonNullable<PutOptions['storageClass']>;
	};
	body?: BodyInit;
	headers?: Record<string, string>;
};

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
	request: Request = {},
): Promise<Exchange> {
	const url =
		request.url ??
		context.client.presign(key, { method, expiresIn: 60, ...request.signed });
	try {
		const response = await fetch(url, {
			method,
			signal,
			...(request.body === undefined ? {} : { body: request.body }),
			...(request.headers ? { headers: request.headers } : {}),
		});
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
function failure(response: Exchange, key: string): Error {
	// A HEAD has no body (read as empty): Bun itself says only that it was
	// unexpected.
	const body = new TextDecoder().decode(response.body);
	const field = (tag: string) =>
		new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1];
	// Measured: Bun reads a 404 with no S3 body (a proxy's) as `NoSuchKey`.
	const missing = response.status === 404;
	return s3Error(
		field('Code') ?? (missing ? 'NoSuchKey' : 'UnknownError'),
		key,
		field('Message') ??
			(missing
				? 'The specified key does not exist.'
				: 'an unexpected error has occurred'),
	);
}

/** HEAD: the stats Bun gives, or `undefined` when there is no such object. */
export async function headObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<S3Stats | undefined> {
	const response = await send(context, key, 'HEAD', signal);
	if (response.status === 404) return undefined;
	if (!response.ok) throw failure(response, key);
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
	const error = failure(response, key);
	if ((error as { code?: string }).code === 'NoSuchKey') return undefined;
	throw error;
}

/** DELETE: S3 answers the same for an object that was not there. */
export async function removeObject<P>(
	context: BucketContext<P>,
	key: string,
	signal: AbortSignal,
): Promise<void> {
	const response = await send(context, key, 'DELETE', signal);
	if (!response.ok) throw failure(response, key);
}

/** What a listing sends: the request is signed as a whole, as a URL. */
export async function getListing<P>(
	context: BucketContext<P>,
	url: string,
	signal: AbortSignal,
): Promise<string> {
	const response = await send(context, '', 'GET', signal, { url });
	if (!response.ok) throw failure(response, '');
	return new TextDecoder().decode(response.body);
}

/** What a PUT carries beyond the key: the body and the headers it is served with. */
export type PutRequest = {
	body: BodyInit;
	headers: Record<string, string>;
	signed: NonNullable<Request['signed']>;
};

/**
 * PUT: stores the body. `acl` and `storageClass` are signed into the URL by
 * Bun; the type, disposition and encoding are plain headers, which SeaweedFS
 * stores although they are not signed (measured on 4.47, see the spec).
 */
export async function storeObject<P>(
	context: BucketContext<P>,
	key: string,
	request: PutRequest,
	signal: AbortSignal,
): Promise<void> {
	const response = await send(context, key, 'PUT', signal, request);
	if (!response.ok) throw failure(response, key);
}

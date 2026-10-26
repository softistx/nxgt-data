import type { PutBody } from '../types';

/**
 * What `fetch` can send as it is: it sets `Content-Length` itself for these.
 * An `S3File` is a `Blob` whose `size` is `NaN` (nothing has asked the
 * service), so it is not one of them.
 */
function sendable(body: PutBody): boolean {
	if (typeof body === 'string') return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	return body instanceof Blob && Number.isFinite(body.size);
}

/**
 * The body as `fetch` sends it under a deadline.
 *
 * A string, bytes or a `Blob` of known size go as they are. Anything else —
 * a `ReadableStream`, a `Response`, an `S3File` — is **read into memory
 * first**, inside the deadline: S3 refuses a chunked PUT, which is what
 * `fetch` would send for a stream with no length. A bucket with a `maxSize`
 * has already refused these (`UNMEASURABLE`), so this reaches a bucket
 * without one, and the body's size costs memory there.
 *
 * Reading a body does not stop on an abort by itself (measured on Bun 1.4.3,
 * a stream that never ends held `arrayBuffer()` for ever), so the read is
 * raced against the signal.
 */
export async function fetchBody(
	body: PutBody,
	signal: AbortSignal,
): Promise<BodyInit> {
	if (sendable(body)) return body as BodyInit;
	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		return await Promise.race([
			// `new Response(response)` would store "[object Response]", and
			// `new Response(s3File)` reads as empty (measured on Bun 1.4.3): a
			// body that can read itself is asked to.
			body instanceof Response ||
			body instanceof Request ||
			body instanceof Blob
				? body.arrayBuffer()
				: new Response(body as BodyInit).arrayBuffer(),
			aborted,
		]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

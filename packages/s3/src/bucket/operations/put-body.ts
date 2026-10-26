import type { BunFile } from 'bun';
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
 * A `Bun.file` that is not there, refused as Bun's own `write` refuses it:
 * an `Error` with code `ENOENT` and the file's path, never the signed URL.
 * Without this, `fetch` reports the missing file as a failed connection.
 * A `Bun.file` is a `Blob` with a finite size and an `exists` — an `S3File`'s
 * size is `NaN`, and a plain `Blob` has no `exists`.
 */
async function checkFileThere(body: PutBody): Promise<void> {
	if (!(body instanceof Blob) || !Number.isFinite(body.size)) return;
	const file = body as Partial<BunFile>;
	if (typeof file.exists !== 'function' || (await file.exists())) return;
	const path = file.name ?? '';
	const error = new Error(
		`ENOENT: no such file or directory, open '${path}'`,
	) as Error & { code: string; path: string; errno: number; syscall: string };
	error.code = 'ENOENT';
	error.path = path;
	error.errno = -2;
	error.syscall = 'open';
	throw error;
}

/** The body as a stream to read, or `undefined` when it has no bytes. */
function streamOf(body: PutBody): ReadableStream<Uint8Array> | undefined {
	// `new Response(response)` would store "[object Response]" and
	// `new Response(s3File)` reads as empty (measured on Bun 1.4.3), so a body
	// that can give a stream is asked for it. An `S3File`'s `.stream()` is
	// Bun's own download, and cancelling it stops that download (measured: the
	// server saw the cancel and sent no more).
	if (body instanceof ReadableStream) return body;
	if (body instanceof Response || body instanceof Request) {
		return body.body ?? undefined;
	}
	if (body instanceof Blob) return body.stream();
	return new Response(body as BodyInit).body ?? undefined;
}

/**
 * Reads a stream whole, and **cancels it** when the deadline passes: the
 * source's `cancel` runs and nothing more is pulled (measured on Bun 1.4.3,
 * a read only raced against the signal kept pulling, and held the process
 * open, long after the rejection).
 */
async function gather(
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = stream.getReader();
	const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
	if (signal.aborted) onAbort();
	else signal.addEventListener('abort', onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (signal.aborted) throw signal.reason;
			if (done) break;
			chunks.push(value);
			length += value.byteLength;
		}
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
	const whole = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return whole;
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
 */
export async function fetchBody(
	body: PutBody,
	signal: AbortSignal,
): Promise<BodyInit> {
	await checkFileThere(body);
	if (sendable(body)) return body as BodyInit;
	const stream = streamOf(body);
	return stream ? gather(stream, signal) : new Uint8Array(0);
}

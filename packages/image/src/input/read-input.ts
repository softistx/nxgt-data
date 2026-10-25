import { ImageError } from '../errors/image-error';

export type ImageInput =
	| Uint8Array
	| ArrayBuffer
	| Blob
	| ReadableStream<Uint8Array>;

function tooLarge(maxBytes: number): ImageError {
	return new ImageError(
		'TOO_LARGE',
		'bytes',
		`the upload is over ${maxBytes} bytes`,
	);
}

async function readStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				await reader.cancel().catch(() => undefined);
				throw new TypeError('a stream chunk must be a Uint8Array');
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw tooLarge(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

/**
 * The upload's bytes, refused as soon as they pass `maxBytes`. A size known
 * up front (bytes, a buffer, a `Blob`) is checked before anything is read, and
 * a `Blob`'s again once read; a `Blob` of no known size and a stream are
 * read chunk by chunk and cancelled at the chunk that crosses the cap, so no
 * more than the cap plus one chunk is ever held.
 */
export async function readInput(
	input: ImageInput,
	maxBytes: number,
): Promise<Uint8Array> {
	if (input instanceof Uint8Array) {
		if (input.byteLength > maxBytes) throw tooLarge(maxBytes);
		return input;
	}
	if (input instanceof ArrayBuffer) {
		if (input.byteLength > maxBytes) throw tooLarge(maxBytes);
		return new Uint8Array(input);
	}
	if (input instanceof Blob) {
		// Bun's `S3File` is a Blob whose size is NaN: no comparison with it is
		// true, so a size that is not a number is read through the cap instead.
		if (!Number.isFinite(input.size))
			return readStream(input.stream(), maxBytes);
		if (!(input.size <= maxBytes)) throw tooLarge(maxBytes);
		const buffer = await input.arrayBuffer();
		// The size was only a claim: what was read is checked again.
		if (buffer.byteLength > maxBytes) throw tooLarge(maxBytes);
		return new Uint8Array(buffer);
	}
	if (input instanceof ReadableStream) return readStream(input, maxBytes);
	throw new TypeError(
		'image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array',
	);
}

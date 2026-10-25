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
 * up front (bytes, a buffer, a `Blob`) is checked before anything is read; a
 * stream is read chunk by chunk and cancelled at the chunk that crosses the
 * cap, so no more than the cap plus one chunk is ever held.
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
		if (input.size > maxBytes) throw tooLarge(maxBytes);
		return new Uint8Array(await input.arrayBuffer());
	}
	if (input instanceof ReadableStream) return readStream(input, maxBytes);
	throw new TypeError(
		'image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array',
	);
}

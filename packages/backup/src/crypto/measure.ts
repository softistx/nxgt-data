/** The size and SHA-256 of the bytes that went through a stream. */
export interface Measured {
	size: number;
	sha256: string;
}

/**
 * A pass-through that counts and hashes what goes through it. `result()` is
 * read once the stream has ended; before that it says so rather than
 * answering with a partial digest.
 */
export function measure(): {
	stream: TransformStream<Uint8Array, Uint8Array>;
	result: () => Measured;
} {
	const hasher = new Bun.CryptoHasher('sha256');
	let size = 0;
	let done: Measured | undefined;
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			hasher.update(chunk);
			size += chunk.byteLength;
			controller.enqueue(chunk);
		},
		flush() {
			done = { size, sha256: hasher.digest('hex') };
		},
	});
	return {
		stream,
		result: () => {
			if (!done) throw new Error('measure: the stream has not ended');
			return done;
		},
	};
}

/**
 * A pass-through that fails the stream at its end when what went through
 * is not `expected`: the reader sees an error, never a clean end, after
 * bytes that are not the ones a backup recorded.
 */
export function expect(
	expected: Measured,
	mismatch: () => Error,
): TransformStream<Uint8Array, Uint8Array> {
	const hasher = new Bun.CryptoHasher('sha256');
	let size = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			size += chunk.byteLength;
			if (size > expected.size) {
				controller.error(mismatch());
				return;
			}
			hasher.update(chunk);
			controller.enqueue(chunk);
		},
		flush(controller) {
			if (size !== expected.size || hasher.digest('hex') !== expected.sha256) {
				controller.error(mismatch());
			}
		},
	});
}

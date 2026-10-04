import type { Decrypter } from 'age-encryption';
import { encrypterFor } from './keys';
import { expect, type Measured, measure } from './measure';

/**
 * zstd, as Bun's own `CompressionStream` and `DecompressionStream` give it.
 * Their types take any `BufferSource`; every chunk here is a `Uint8Array`.
 */
export function zstd(
	direction: 'compress' | 'decompress',
): TransformStream<Uint8Array, Uint8Array> {
	const format = 'zstd' as CompressionFormat;
	return (direction === 'compress'
		? new CompressionStream(format)
		: new DecompressionStream(format)) as unknown as TransformStream<
		Uint8Array,
		Uint8Array
	>;
}

/** What sealing one stream produced: what went in, and what was written. */
export interface Sealed {
	plain: Measured;
	stored: Measured;
}

/**
 * Compresses `source` with zstd, encrypts it to `recipients` with age, and
 * writes the result to `path`, measuring both ends. Nothing is held in
 * memory past a chunk: measured on bun 1.4.2, 64 MB went through age at a
 * peak RSS of 88 MB, and through zstd at 63 MB.
 *
 * zstd comes before age because encrypted bytes do not compress.
 */
export async function sealToFile(
	source: ReadableStream<Uint8Array>,
	recipients: readonly string[],
	path: string,
): Promise<Sealed> {
	const plain = measure();
	const stored = measure();
	const compressed = source
		.pipeThrough(plain.stream)
		.pipeThrough(zstd('compress'));
	const encrypted = (await encrypterFor(recipients).encrypt(
		compressed,
	)) as ReadableStream<Uint8Array>;
	await Bun.write(path, new Response(encrypted.pipeThrough(stored.stream)));
	return { plain: plain.result(), stored: stored.result() };
}

/**
 * The plain bytes of a sealed file, checked against what was recorded when
 * it was sealed: the stream fails at its end, never ends cleanly, when they
 * differ. The file itself must have been checked against its stored digest
 * first — this reads it once more, and trusts it.
 *
 * Rejects with age's own error when no identity opens the file: the caller
 * tells that apart from a damaged one.
 */
export async function openFile(
	path: string,
	decrypter: Decrypter,
	plain: Measured,
	mismatch: () => Error,
): Promise<ReadableStream<Uint8Array>> {
	const decrypted = (await decrypter.decrypt(
		Bun.file(path).stream(),
	)) as ReadableStream<Uint8Array>;
	return decrypted
		.pipeThrough(zstd('decompress'))
		.pipeThrough(expect(plain, mismatch));
}

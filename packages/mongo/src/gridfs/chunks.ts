import { Binary, type ObjectId } from 'mongodb';
import { CorruptFileError } from '../errors/data-error';
import type { BucketContext } from './context';

/** MongoDB's own default, and the one a bucket takes when it names none. */
export const DEFAULT_CHUNK_SIZE = 255 * 1024;

/** How many chunk documents go in one insert. */
const BATCH = 16;

/**
 * The bytes of a chunk document.
 *
 * The driver gives `data` back as a `Binary`, whose bytes are on `.buffer`.
 * A chunk written by something else may be a plain `Uint8Array`, so both are
 * read rather than only the one this package writes.
 */
function bytesOf(data: unknown): Uint8Array {
	if (data instanceof Binary) return data.buffer;
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new CorruptFileError('A chunk of this file holds no bytes');
}

/**
 * Writes the chunks of a file, and answers its length.
 *
 * The chunks are this package's own inserts rather than
 * `GridFSBucket.openUploadStream`, because **the driver's GridFS takes no
 * session at all** — measured on mongodb 7.6.0, neither the upload options,
 * nor the download options, nor `delete`, nor `rename` has one. A write
 * through the bucket would leave the transaction it was asked to run in,
 * silently. Doing it here is also what lets the digest be stored with the
 * file rather than added afterwards, since the last chunk and the `files`
 * document are written in that order by this function's caller.
 */
export async function writeChunks(
	ctx: BucketContext,
	filesId: ObjectId,
	chunkSize: number,
	source: AsyncIterable<Uint8Array>,
	onBytes?: (bytes: Uint8Array) => void,
): Promise<number> {
	let length = 0;
	let n = 0;
	let held = new Uint8Array(chunkSize);
	let filled = 0;
	let batch: { files_id: ObjectId; n: number; data: Binary }[] = [];

	const flushBatch = async () => {
		if (batch.length === 0) return;
		await ctx.chunks.insertMany(batch, { ...ctx.sessionOption, ordered: true });
		batch = [];
	};
	const emit = async () => {
		batch.push({
			files_id: filesId,
			n: n++,
			// A copy, because `held` is reused for the chunk that follows.
			data: new Binary(held.slice(0, filled)),
		});
		filled = 0;
		if (batch.length >= BATCH) await flushBatch();
	};

	for await (const piece of source) {
		onBytes?.(piece);
		length += piece.byteLength;
		let offset = 0;
		while (offset < piece.byteLength) {
			const room = chunkSize - filled;
			const take = Math.min(room, piece.byteLength - offset);
			held.set(piece.subarray(offset, offset + take), filled);
			filled += take;
			offset += take;
			if (filled === chunkSize) {
				await emit();
				held = new Uint8Array(chunkSize);
			}
		}
	}
	// GridFS stores no empty trailing chunk, and a file of no bytes has none
	// at all — which is what the specification says and what the driver does.
	if (filled > 0) await emit();
	await flushBatch();
	return length;
}

/** Removes every chunk of a file. */
export async function dropChunks(
	ctx: BucketContext,
	filesId: ObjectId,
): Promise<void> {
	await ctx.chunks.deleteMany({ files_id: filesId }, ctx.sessionOption);
}

/**
 * The bytes of a file, as a web stream, reading only the chunks a range
 * spans.
 *
 * `end` is exclusive, matching both `openDownloadStream` — measured — and
 * every other half-open range in this package.
 */
export function readChunks(
	ctx: BucketContext,
	filesId: ObjectId,
	chunkSize: number,
	length: number,
	range?: { start?: number; end?: number },
): ReadableStream<Uint8Array> {
	const start = Math.max(0, Math.min(range?.start ?? 0, length));
	const end = Math.max(start, Math.min(range?.end ?? length, length));
	if (end === start) return new ReadableStream({ start: (c) => c.close() });

	const firstChunk = Math.floor(start / chunkSize);
	const lastChunk = Math.ceil(end / chunkSize) - 1;
	const cursor = ctx.chunks
		.find(
			{ files_id: filesId, n: { $gte: firstChunk, $lte: lastChunk } },
			ctx.sessionOption,
		)
		.sort({ n: 1 });

	let expected = firstChunk;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const chunk = await cursor.next();
			if (!chunk) {
				if (expected <= lastChunk) {
					controller.error(missingChunk(ctx, filesId, expected));
					return;
				}
				controller.close();
				await cursor.close();
				return;
			}
			if (chunk.n !== expected) {
				controller.error(missingChunk(ctx, filesId, expected));
				return;
			}
			const bytes = bytesOf(chunk.data);
			const at = expected * chunkSize;
			// Only the first and the last chunk are ever cut.
			const from = Math.max(0, start - at);
			const to = Math.min(bytes.byteLength, end - at);
			expected += 1;
			if (to > from) controller.enqueue(bytes.subarray(from, to));
		},
		cancel: () => cursor.close(),
	});
}

function missingChunk(
	ctx: BucketContext,
	filesId: ObjectId,
	n: number,
): CorruptFileError {
	return new CorruptFileError(
		`Chunk ${n} of file ${String(filesId)} in "${ctx.name}" is missing`,
		{ collection: ctx.definition.collections.chunks, id: filesId },
	);
}

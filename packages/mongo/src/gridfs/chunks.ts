import { Binary, ObjectId } from 'mongodb';
import { CorruptFileError } from '../errors/data-error';
import { type BucketContext, run } from './context';

/** MongoDB's own default, and the one a bucket takes when it names none. */
export const DEFAULT_CHUNK_SIZE = 255 * 1024;

/** How many chunk documents go in one insert. */
const BATCH = 16;

/**
 * The unique index GridFS requires, by the name the server reports it under.
 *
 * Named here because it is not only an index: it is what refuses the second
 * of two writers reaching for the same chunk of the same file, which is half
 * of how `putOnce` elects between them.
 */
export const CHUNK_INDEX = 'files_id_1_n_1';

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
	written?: ObjectId[],
): Promise<number> {
	let length = 0;
	let n = 0;
	let held = new Uint8Array(chunkSize);
	let filled = 0;
	let batch: { _id: ObjectId; files_id: ObjectId; n: number; data: Binary }[] =
		[];

	const flushBatch = async () => {
		if (batch.length === 0) return;
		const going = batch;
		batch = [];
		// Recorded **before** the insert, not after: a batch that fails partway
		// has landed some of its documents, and an id this call never records
		// is an orphan chunk nothing will clean up.
		if (written) for (const one of going) written.push(one._id);
		await ctx.chunks.insertMany(going, {
			...ctx.sessionOption,
			ordered: true,
		});
	};
	const emit = async () => {
		batch.push({
			// The id is this package's rather than the driver's, so that a write
			// that fails can remove exactly the chunks **it** wrote. Deleting by
			// `files_id` would take the chunks of whatever else is stored under
			// that id with it.
			_id: new ObjectId(),
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

/**
 * Removes the chunk documents this call wrote, and nothing else.
 *
 * By `_id` rather than by `files_id`: a write onto an id that is already
 * taken must not take the stored file's bytes down with it.
 */
export async function dropChunks(
	ctx: BucketContext,
	ids: readonly ObjectId[],
): Promise<void> {
	if (ids.length === 0) return;
	await ctx.chunks.deleteMany({ _id: { $in: [...ids] } }, ctx.sessionOption);
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
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				// Through `run` like every other call to the driver, so that a
				// failure while reading bytes is this package's error and not a
				// raw `MongoError`. The cursor is closed on the way out as
				// well: measured, the driver closes it itself when a read
				// fails, so this leaks nothing either way — but `cancel` is not
				// called when a stream errors from inside `pull`, and this is
				// the only place left that could close it.
				const chunk = await run(
					ctx,
					() => cursor.next(),
					ctx.definition.collections.chunks,
				);
				if (!chunk) {
					if (expected <= lastChunk) {
						throw missingChunk(ctx, filesId, expected);
					}
					// Every chunk was there and the bytes still do not add up:
					// one of them holds fewer than it should. Counting the
					// numbers is not enough — a chunk truncated in place leaves
					// no gap, and without this the read comes back quietly
					// short, which is the corruption that costs something.
					if (sent !== end - start) {
						throw shortFile(ctx, filesId, end - start, sent);
					}
					controller.close();
					await cursor.close();
					return;
				}
				if (chunk.n !== expected) throw missingChunk(ctx, filesId, expected);
				const bytes = bytesOf(chunk.data);
				const at = expected * chunkSize;
				// Only the first and the last chunk are ever cut.
				const from = Math.max(0, start - at);
				const to = Math.min(bytes.byteLength, end - at);
				expected += 1;
				if (to > from) {
					sent += to - from;
					controller.enqueue(bytes.subarray(from, to));
				}
			} catch (error) {
				await cursor.close().catch(() => undefined);
				controller.error(error);
			}
		},
		cancel: () => cursor.close(),
	});
}

/** Every chunk was present, and together they hold fewer bytes than promised. */
function shortFile(
	ctx: BucketContext,
	filesId: ObjectId,
	wanted: number,
	got: number,
): CorruptFileError {
	return new CorruptFileError(
		`File ${String(filesId)} in "${ctx.name}" reads ${got} bytes where its ` +
			`chunks should hold ${wanted}: a chunk of it was truncated`,
		{ collection: ctx.definition.collections.chunks, id: filesId },
	);
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

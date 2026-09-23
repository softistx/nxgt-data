import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { toObjectId } from '../../definition/object-id';
import { ConflictError } from '../../errors/data-error';
import { DEFAULT_CHUNK_SIZE, dropChunks, writeChunks } from '../chunks';
import { type BucketContext, noSuchFile, run } from '../context';
import { FileHandle, type StoredFile } from '../handle';
import { HASH_KEY } from '../keys';
import { metadataFor } from '../metadata';
import { type FileSource, type ReadSource, readSource } from '../source';
import type { FileId } from '../types';
import { fileExists, findFile } from './reads';

export interface PutOptions {
	/** The name to store. Defaults to the one the source carries, else `''`. */
	filename?: string;
	/** The content type. Defaults to the one the source carries. */
	type?: string;
	/** The `_id` to give it, instead of a generated one. */
	id?: FileId;
	/** This file's metadata, as the bucket's schema describes it. */
	metadata?: unknown;
	/** Overrides the bucket's chunk size for this file alone. */
	chunkSize?: number;
}

/**
 * Writes a file, and gives back the handle to it.
 *
 * The chunks go first and the `files` document last, which is the order the
 * GridFS specification asks for: a reader that arrives in between finds no
 * file at all, rather than a file whose bytes are still arriving. It also
 * means the digest is known by the time the document is written, so it is
 * stored **with** the file and not added by a second write.
 */
export async function putFile(
	ctx: BucketContext,
	source: FileSource,
	options: PutOptions = {},
): Promise<FileHandle> {
	const read = readSource(source, `put on "${ctx.name}"`);
	const _id =
		options.id === undefined ? new ObjectId() : toObjectId(options.id);
	// An id the caller chose may already be taken, and a write onto a taken id
	// cannot be allowed to start: it would fail on the `files` document at the
	// very end, after the stored file's bytes had already been written over.
	// The unique `{ files_id, n }` index is what settles the race that is left;
	// this is what turns the common case into an error rather than a loss.
	if (options.id !== undefined && (await fileExists(ctx, _id))) {
		throw new ConflictError(
			`put: "${ctx.name}" already has a file with _id ${String(_id)}. ` +
				'Delete it first, or let the bucket give the file an id.',
			{ collection: ctx.definition.collections.files, id: _id },
		);
	}
	const body = await writeBody(
		ctx,
		read,
		putOptionsFor(ctx, read, options),
		_id,
	);
	await insertDocument(ctx, body);
	return new FileHandle(ctx, body.document);
}

/**
 * What a write stores about the file, once the source has had its say.
 *
 * Resolved here rather than at each call site: the metadata is checked
 * against the bucket's schema on the way through, so a write that names an
 * unknown field fails before a single byte goes over.
 */
export function putOptionsFor(
	ctx: BucketContext,
	read: ReadSource,
	options: PutOptions,
): BodyOptions {
	return {
		chunkSize:
			options.chunkSize ?? ctx.definition.chunkSize ?? DEFAULT_CHUNK_SIZE,
		filename: options.filename ?? read.filename ?? '',
		metadata: metadataFor(ctx, options.metadata, options.type ?? read.type),
	};
}

interface BodyOptions {
	chunkSize: number;
	filename: string;
	metadata: ReturnType<typeof metadataFor>;
}

/** A file's bytes, written, and the document that has not been inserted yet. */
export interface WrittenBody {
	document: StoredFile;
	/**
	 * The chunk documents this call wrote, in the order it wrote them, so
	 * that a failure removes its own and only its own — and so that the first
	 * of them is chunk `n: 0`.
	 */
	written: ObjectId[];
	/** The digest of what was written, or `''` on a bucket that keeps none. */
	digest: string;
}

/**
 * Writes the chunks, and builds the `files` document without inserting it.
 *
 * The document comes back rather than going in, because what `putOnce` does
 * between the last chunk and that insert is the whole of its election.
 */
export async function writeBody(
	ctx: BucketContext,
	read: ReadSource,
	of: BodyOptions,
	_id: ObjectId,
): Promise<WrittenBody> {
	const hash = ctx.hashes ? createHash('sha256') : undefined;
	const written: ObjectId[] = [];
	const length = await run(
		ctx,
		async () => {
			try {
				return await writeChunks(
					ctx,
					_id,
					of.chunkSize,
					read.chunks,
					(bytes) => hash?.update(bytes),
					written,
				);
			} catch (error) {
				// A write that failed must leave nothing behind. Inside a
				// transaction the rollback does it; outside one, this does.
				await dropChunks(ctx, written).catch(() => undefined);
				throw error;
			}
		},
		ctx.definition.collections.chunks,
	);
	const digest = hash ? hash.digest('hex') : '';
	return {
		document: {
			_id,
			length,
			chunkSize: of.chunkSize,
			uploadDate: new Date(),
			filename: of.filename,
			metadata: hash ? { ...of.metadata, [HASH_KEY]: digest } : of.metadata,
		},
		written,
		digest,
	};
}

/** Inserts the `files` document, and takes the chunks down with it if it fails. */
async function insertDocument(
	ctx: BucketContext,
	body: WrittenBody,
): Promise<void> {
	try {
		await run(ctx, () => ctx.files.insertOne(body.document, ctx.sessionOption));
	} catch (error) {
		await dropChunks(ctx, body.written).catch(() => undefined);
		throw error;
	}
}

/**
 * The two deletes GridFS makes, written out here rather than called on the
 * bucket.
 *
 * `GridFSBucket.delete` takes only a `timeoutMS` in mongodb 7.6 — no session
 * — so a delete through it would silently escape the transaction it was
 * meant to run in. The `files` document goes first, so a reader that arrives
 * in between finds nothing rather than a file with no bytes.
 */
async function removeFile(ctx: BucketContext, _id: ObjectId): Promise<void> {
	// One `run` per collection: a failure on the second of the two is a
	// failure on `.chunks`, and an error that names `.files` sends whoever
	// greps for it to the wrong one.
	await run(
		ctx,
		() => ctx.files.deleteOne({ _id }, ctx.sessionOption),
		ctx.definition.collections.files,
	);
	await run(
		ctx,
		() => ctx.chunks.deleteMany({ files_id: _id }, ctx.sessionOption),
		ctx.definition.collections.chunks,
	);
}

/** Removes the file and its chunks. A file that is not there is a `NotFoundError`. */
export async function deleteFile(
	ctx: BucketContext,
	id: FileId,
): Promise<void> {
	const found = await findFile(ctx, id);
	if (!found) throw noSuchFile(ctx, id);
	await removeFile(ctx, found._id);
}

/** Renames it. The bytes are untouched. */
export async function renameFile(
	ctx: BucketContext,
	id: FileId,
	filename: string,
): Promise<void> {
	const found = await findFile(ctx, id);
	if (!found) throw noSuchFile(ctx, id);
	// `GridFSBucket.rename` takes no session either — see `removeFile`.
	await run(ctx, () =>
		ctx.files.updateOne(
			{ _id: found._id },
			{ $set: { filename } },
			ctx.sessionOption,
		),
	);
}

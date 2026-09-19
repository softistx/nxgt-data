import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { toObjectId } from '../../definition/object-id';
import { ConflictError } from '../../errors/data-error';
import { DEFAULT_CHUNK_SIZE, dropChunks, writeChunks } from '../chunks';
import { type BucketContext, noSuchFile, run } from '../context';
import { FileHandle, HASH_KEY, type StoredFile } from '../handle';
import { metadataFor } from '../metadata';
import { type FileSource, readSource } from '../source';
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
	const read = readSource(source);
	const type = options.type ?? read.type;
	const metadata = metadataFor(ctx, options.metadata, type);
	const filename = options.filename ?? read.filename ?? '';
	const chunkSize =
		options.chunkSize ?? ctx.definition.chunkSize ?? DEFAULT_CHUNK_SIZE;
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
	const hash = ctx.hashes ? createHash('sha256') : undefined;
	// The chunk documents this call wrote, so that a failure removes its own
	// and only its own.
	const written: ObjectId[] = [];

	const length = await run(
		ctx,
		async () => {
			try {
				return await writeChunks(
					ctx,
					_id,
					chunkSize,
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

	const document: StoredFile = {
		_id,
		length,
		chunkSize,
		uploadDate: new Date(),
		filename,
		metadata: hash ? { ...metadata, [HASH_KEY]: hash.digest('hex') } : metadata,
	};
	try {
		await run(ctx, () => ctx.files.insertOne(document, ctx.sessionOption));
	} catch (error) {
		await dropChunks(ctx, written).catch(() => undefined);
		throw error;
	}
	return new FileHandle(ctx, document);
}

/** What `putOnce` answers: the file, and whether this call is what wrote it. */
export interface PutOnceResult {
	file: FileHandle;
	stored: boolean;
}

/**
 * The file with these bytes, written only if the bucket does not have it.
 *
 * A `Blob` — `Bun.file` included — can be streamed more than once, so its
 * digest is taken first and nothing is uploaded when the bucket already has
 * it. Anything else is read once by definition, so it is uploaded and then
 * compared.
 *
 * Either way the write ends in `keepOne`, which is what makes two callers
 * storing the same bytes **at the same time** safe: the check above cannot
 * see a file whose `files` document has not been written yet.
 */
export async function putFileOnce(
	ctx: BucketContext,
	source: FileSource,
	options: PutOptions = {},
): Promise<PutOnceResult> {
	if (!ctx.hashes) {
		throw new TypeError(
			`putOnce: "${ctx.name}" is bound with \`hash: false\`, and without a ` +
				'digest there is nothing to compare. Leave `hash` alone, or use `put`.',
		);
	}
	if (source instanceof Blob) {
		const digest = await digestOf(source);
		const already = await fileWithHash(ctx, digest);
		if (already) return { file: already, stored: false };
	}
	return await keepOne(ctx, await putFile(ctx, source, options));
}

/**
 * Of the copies carrying these bytes, the first one wins — and it is the same
 * one whoever asks.
 *
 * Removing "the copy that is not mine" is what a first reading suggests, and
 * it loses the file outright: run twice at once, each call finds the other,
 * each removes itself, and the bucket ends up empty while both callers are
 * told the bytes were already safely stored. So the rule is one every caller
 * computes the same way — the copy that comes **first** in the order
 * `putOnce` reads by, `(uploadDate, _id)`, is the one kept — and a caller
 * removes only **itself**, and only when it is not that one. Exactly one copy
 * survives, whatever the order the calls happen to run in.
 */
async function keepOne(
	ctx: BucketContext,
	written: FileHandle,
): Promise<PutOnceResult> {
	const digest = written.sha256 ?? '';
	const already = await fileWithHash(ctx, digest, written._id);
	if (!already || !precedes(already, written)) {
		return { file: written, stored: true };
	}
	await removeFile(ctx, written._id);
	// Read again rather than hand back `already`: the copy this call saw may
	// itself be removing itself against an older one it could see and this
	// call could not, and a handle to a document that is gone reads as a
	// `CorruptFileError`. The copy that is there now is the one to give.
	const survivor = await fileWithHash(ctx, digest);
	return { file: survivor ?? already, stored: false };
}

/** `(uploadDate, _id)`, which is the order `fileWithHash` sorts by. */
function precedes(one: FileHandle, other: FileHandle): boolean {
	const mine = one.uploadDate.getTime();
	const theirs = other.uploadDate.getTime();
	if (mine !== theirs) return mine < theirs;
	// An `ObjectId`'s hex string compares as its bytes do, which is how the
	// server ordered the two in the sort above.
	return String(one._id) < String(other._id);
}

async function digestOf(blob: Blob): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of blob.stream()) hash.update(chunk);
	return hash.digest('hex');
}

/** The oldest file carrying this digest, which is the one to keep. */
async function fileWithHash(
	ctx: BucketContext,
	digest: string,
	besides?: ObjectId,
): Promise<FileHandle | undefined> {
	if (!digest) return undefined;
	const stored = await run(ctx, () =>
		ctx.files.findOne<StoredFile>(
			{
				[`metadata.${HASH_KEY}`]: digest,
				...(besides ? { _id: { $ne: besides } } : {}),
			},
			{ ...ctx.sessionOption, sort: { uploadDate: 1, _id: 1 } },
		),
	);
	return stored ? new FileHandle(ctx, stored) : undefined;
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

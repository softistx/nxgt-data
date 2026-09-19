import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { toObjectId } from '../../definition/object-id';
import { DEFAULT_CHUNK_SIZE, dropChunks, writeChunks } from '../chunks';
import { type BucketContext, noSuchFile, run } from '../context';
import { FileHandle, HASH_KEY, type StoredFile } from '../handle';
import { metadataFor } from '../metadata';
import { type FileSource, readSource } from '../source';
import type { FileId } from '../types';
import { findFile } from './reads';

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
	const hash = ctx.hashes ? createHash('sha256') : undefined;

	const length = await run(ctx, async () => {
		try {
			return await writeChunks(ctx, _id, chunkSize, read.chunks, (bytes) =>
				hash?.update(bytes),
			);
		} catch (error) {
			// A write that failed must leave nothing behind. Inside a
			// transaction the rollback does it; outside one, this does.
			await dropChunks(ctx, _id).catch(() => undefined);
			throw error;
		}
	});

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
		await dropChunks(ctx, _id).catch(() => undefined);
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
 * compared: the duplicate is removed, and the file that was already there is
 * the one given back.
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
		return { file: await putFile(ctx, source, options), stored: true };
	}
	const written = await putFile(ctx, source, options);
	const already = await fileWithHash(ctx, written.sha256 ?? '', written._id);
	if (!already) return { file: written, stored: true };
	await removeFile(ctx, written._id);
	return { file: already, stored: false };
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
	await run(ctx, async () => {
		await ctx.files.deleteOne({ _id }, ctx.sessionOption);
		await ctx.chunks.deleteMany({ files_id: _id }, ctx.sessionOption);
	});
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

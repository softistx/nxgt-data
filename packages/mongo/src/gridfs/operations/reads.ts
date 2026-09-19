import { tryObjectId } from '../../definition/object-id';
import { type BucketContext, noSuchFile, run } from '../context';
import { FileHandle, type StoredFile } from '../handle';
import type { FileId } from '../types';

/**
 * The file, or `undefined`. Reads the `files` document and nothing else.
 *
 * An id that is not 24 hex characters matches nothing, exactly as it does on
 * a collection: the rule across this package is that reading a string never
 * throws, so a mistyped path parameter is a 404 and not a 400.
 */
export async function findFile(
	ctx: BucketContext,
	id: FileId,
): Promise<FileHandle | undefined> {
	const _id = tryObjectId(id);
	if (!_id) return undefined;
	const stored = await run(ctx, () =>
		ctx.files.findOne<StoredFile>({ _id }, ctx.sessionOption),
	);
	return stored ? new FileHandle(ctx, stored) : undefined;
}

/** The file, or `NotFoundError`. */
export async function getFile(
	ctx: BucketContext,
	id: FileId,
): Promise<FileHandle> {
	const found = await findFile(ctx, id);
	if (!found) throw noSuchFile(ctx, id);
	return found;
}

export async function fileExists(
	ctx: BucketContext,
	id: FileId,
): Promise<boolean> {
	const _id = tryObjectId(id);
	if (!_id) return false;
	const found = await run(ctx, () =>
		ctx.files.findOne<StoredFile>(
			{ _id },
			{ ...ctx.sessionOption, projection: { _id: 1 } },
		),
	);
	return found !== null;
}

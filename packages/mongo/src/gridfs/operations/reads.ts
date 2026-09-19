import { toObjectId } from '../../definition/object-id';
import { type BucketContext, noSuchFile, run } from '../context';
import { FileHandle, type StoredFile } from '../handle';
import type { FileId } from '../types';

/** The file, or `undefined`. Reads the `files` document and nothing else. */
export async function findFile(
	ctx: BucketContext,
	id: FileId,
): Promise<FileHandle | undefined> {
	const _id = toObjectId(id);
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
	const _id = toObjectId(id);
	const found = await run(ctx, () =>
		ctx.files.findOne<StoredFile>(
			{ _id },
			{ ...ctx.sessionOption, projection: { _id: 1 } },
		),
	);
	return found !== null;
}

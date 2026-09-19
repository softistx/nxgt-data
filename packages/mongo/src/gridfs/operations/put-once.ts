import { ObjectId } from 'mongodb';
import { dropChunks } from '../chunks';
import type { BucketContext } from '../context';
import { syncBucketIndexesOnce } from '../indexes';
import { digestOf, type FileSource, readSource } from '../source';
import { claim, giveUp, type PutOnceResult } from './claim';
import { fileWithDigest } from './reads';
import { type PutOptions, putOptionsFor, writeBody } from './writes';

export type { PutOnceResult };

/**
 * The file with these bytes, written only if the bucket does not have it.
 *
 * A `Blob` — `Bun.file` included — can be streamed more than once, so its
 * digest is taken first and nothing is uploaded when the bucket already has
 * it. Anything else is read once by definition, so it is uploaded and then
 * compared.
 *
 * What makes two callers storing the same bytes **at the same time** safe is
 * neither of those checks: a check cannot see a file whose `files` document
 * has not been written yet. It is that the bytes decide the id, so the copies
 * collide on the server, on the unique `{ files_id, n }` index and then on
 * `_id`. A caller that loses the collision has written nothing that survives
 * and removes only the chunks it wrote itself: **`putOnce` never deletes a
 * stored file.**
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
	if (options.id !== undefined) {
		throw new TypeError(
			'putOnce: the bytes decide the id, so this call cannot be given one. ' +
				'Use `put` to choose an id, or drop `id` to store these bytes once.',
		);
	}
	// The unique `{ files_id, n }` index is half of the election, so this is
	// the one call that does not leave it to `autoSync`: without it two
	// callers' chunks both land under the id the bytes decided, and the file
	// reads as corrupt until the one that loses has taken its own back out.
	// It is GridFS's own required index, created once per process and per
	// bucket, and outside the transaction — mongod refuses `createIndexes`
	// inside one.
	await syncBucketIndexesOnce(ctx);
	if (source instanceof Blob) {
		const already = await fileWithDigest(ctx, await digestOf(source));
		if (already) return { file: already, stored: false };
	}
	const read = readSource(source);
	// The bytes go down under an id of this call's own, because the id they
	// decide is not known until the last of them has been read.
	const body = await writeBody(
		ctx,
		read,
		putOptionsFor(ctx, read, options),
		new ObjectId(),
	);
	try {
		// A copy that was already there, finished, is the answer — including
		// one written by `put`, which has no id the digest decides. Asked
		// before anything of this call's is claimed, so a caller only ever
		// gives up, and two callers can never give up in favour of each other.
		const already = await fileWithDigest(ctx, body.digest);
		if (already) return await giveUp(ctx, body, already);
		return await claim(ctx, body);
	} catch (error) {
		await dropChunks(ctx, body.written).catch(() => undefined);
		throw error;
	}
}

import { ObjectId } from 'mongodb';
import { ConflictError } from '../../errors/data-error';
import { CHUNK_INDEX, dropChunks } from '../chunks';
import { type BucketContext, run } from '../context';
import { FileHandle } from '../handle';
import { fileWithDigest, findFile } from './reads';
import type { WrittenBody } from './writes';

/** What `putOnce` answers: the file, and whether this call is what wrote it. */
export interface PutOnceResult {
	file: FileHandle;
	stored: boolean;
}

/**
 * The id the bytes themselves decide.
 *
 * `_id` is unique, always indexed, and enforced by the server, so claiming it
 * **is** the election: two callers storing the same bytes cannot both win,
 * whatever order they happen to run in. Twelve bytes of the digest, because
 * that is what an `ObjectId` holds — which also means the date one of these
 * ids appears to carry is not a date. `uploadDate` is.
 */
function onceId(digest: string): ObjectId {
	return ObjectId.createFromHexString(digest.slice(0, 24));
}

/**
 * Stores what was written under the id its bytes decide, or gives back the
 * copy that got there first.
 *
 * Two claims, in this order and no other. The first chunk goes over first,
 * alone: `{ files_id, n }` is unique, so exactly one caller can move an `n:
 * 0` onto that id, and a caller that cannot has moved nothing. Only then do
 * the rest follow, and the `files` document goes in last, the order the
 * GridFS specification asks for.
 *
 * `until` is the deadline for the whole call and not for one wait, so taking
 * an abandoned id over cannot add a second ten seconds to it.
 */
export async function claim(
	ctx: BucketContext,
	body: WrittenBody,
	retries = 1,
	until = Date.now() + WAIT_MS,
): Promise<PutOnceResult> {
	const _id = onceId(body.digest);
	const [first, ...rest] = body.written;
	if (first && !(await moveChunks(ctx, [first], _id))) {
		return await lost(ctx, body, { _id, claimed: true, retries, until });
	}
	// The rest cannot be refused by a caller running now: nobody else can be
	// moving chunks onto an id whose first one this call holds. What can
	// refuse them is a chunk left behind under that id by a write that died
	// between these two moves — and then the file would be stored short, and
	// read as corrupt, which is exactly what this call exists to prevent. A
	// stray past this file's last chunk collides with nothing and is left
	// where it is; it goes when the file does.
	if (rest.length > 0 && !(await moveChunks(ctx, rest, _id))) {
		throw strayChunks(ctx, _id);
	}
	const document = { ...body.document, _id };
	try {
		await run(ctx, () => ctx.files.insertOne(document, ctx.sessionOption));
	} catch (error) {
		// A file of no bytes has no chunks, so this is the only claim it
		// makes, and the only way a second caller learns it lost.
		if (!(error instanceof ConflictError)) throw error;
		return await lost(ctx, body, {
			_id,
			claimed: first !== undefined,
			retries,
			until,
		});
	}
	return { file: new FileHandle(ctx, document), stored: true };
}

/**
 * What to answer when the id would not be taken.
 *
 * Either the copy that holds it — the usual case, and what the caller asked
 * for — or, when whoever held it let go without finishing, another attempt:
 * this call is holding every byte the id needs, so waiting for a document
 * nobody is writing would be waiting for nothing.
 */
async function lost(
	ctx: BucketContext,
	body: WrittenBody,
	on: { _id: ObjectId; claimed: boolean; retries: number; until: number },
): Promise<PutOnceResult> {
	const won = await winner(ctx, on._id, body.digest, on.claimed, on.until);
	if (won) return await giveUp(ctx, body, won);
	if (on.retries <= 0) throw keptSlipping(ctx, on._id);
	// Asked again, because the answer is now as old as the wait was long: a
	// plain `put` of these bytes takes no part in the election, and one that
	// landed while this call was waiting is the copy to give back.
	const already = await fileWithDigest(ctx, body.digest);
	if (already) return await giveUp(ctx, body, already);
	return await claim(ctx, body, on.retries - 1, on.until);
}

/**
 * Puts these chunks under `filesId`, and says whether they went.
 *
 * `false` means the unique `{ files_id, n }` index refused the move, which is
 * what elects between two callers. Any other conflict is somebody else's and
 * is raised: a `WriteConflict` inside a transaction is code 112, never this.
 */
async function moveChunks(
	ctx: BucketContext,
	ids: readonly ObjectId[],
	filesId: ObjectId,
): Promise<boolean> {
	try {
		await run(
			ctx,
			() =>
				ctx.chunks.updateMany(
					{ _id: { $in: [...ids] } },
					{ $set: { files_id: filesId } },
					ctx.sessionOption,
				),
			ctx.definition.collections.chunks,
		);
		return true;
	} catch (error) {
		if (error instanceof ConflictError && error.index === CHUNK_INDEX) {
			return false;
		}
		throw error;
	}
}

/**
 * Drops what this call wrote, and answers with the copy that is stored.
 *
 * The delete is allowed to fail: a chunk left behind costs a little space,
 * and losing the handle this call has earned costs the caller its answer.
 */
export async function giveUp(
	ctx: BucketContext,
	body: WrittenBody,
	file: FileHandle,
): Promise<PutOnceResult> {
	await dropChunks(ctx, body.written).catch(() => undefined);
	return { file, stored: false };
}

/** How long a call waits for the `files` document of the copy that beat it. */
const WAIT_MS = 10_000;
const POLL_MS = 20;

/**
 * The copy that won this id, once its `files` document is in — or `undefined`
 * when the write that held the id let go of it.
 *
 * A caller loses the collision while the winner is between its chunks and its
 * document — one round trip, not an upload, since a caller that has claimed
 * the first chunk has already written every byte. It is still a wait, so it
 * is bounded, and it ends on what it actually saw rather than on what it
 * assumed: a claim that is still there, or one that is gone.
 *
 * There is no case for a session here. Measured: inside a transaction the
 * duplicate key aborts the transaction on the server, so the read below is
 * what raises, with the driver's own abort — the wait is never reached.
 */
async function winner(
	ctx: BucketContext,
	_id: ObjectId,
	digest: string,
	claimed: boolean,
	until: number,
): Promise<FileHandle | undefined> {
	for (;;) {
		const found = await findFile(ctx, _id);
		if (found) {
			// The id is twelve bytes of a digest, and two files whose digests
			// share those twelve bytes are not the same file. Nothing has
			// stored one; this is what it would look like if something did.
			if ((found.sha256 ?? '') !== digest) throw otherBytes(ctx, _id);
			return found;
		}
		// No document, and the chunk that stood for the claim is gone too:
		// whoever held it gave up rather than finished. A file of no bytes
		// claims nothing but its document, so there is nothing to look at.
		if (claimed && !(await firstChunkHeld(ctx, _id))) return undefined;
		if (Date.now() >= until) throw heldTooLong(ctx, _id);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/** Whether a chunk `n: 0` is still there under this id. */
async function firstChunkHeld(
	ctx: BucketContext,
	filesId: ObjectId,
): Promise<boolean> {
	const chunk = await run(
		ctx,
		() =>
			ctx.chunks.findOne(
				{ files_id: filesId, n: 0 },
				{ ...ctx.sessionOption, projection: { _id: 1 } },
			),
		ctx.definition.collections.chunks,
	);
	return chunk !== null;
}

function heldTooLong(ctx: BucketContext, _id: ObjectId): ConflictError {
	return new ConflictError(
		`putOnce: another write holds _id ${String(_id)} in "${ctx.name}" and ` +
			'has not finished. Its chunks are still there and its file is not: ' +
			'remove them, or retry.',
		{ collection: ctx.definition.collections.files, id: _id },
	);
}

function keptSlipping(ctx: BucketContext, _id: ObjectId): ConflictError {
	return new ConflictError(
		`putOnce: _id ${String(_id)} in "${ctx.name}" was claimed and let go ` +
			'again while this write was taking it over. Retry.',
		{ collection: ctx.definition.collections.files, id: _id },
	);
}

function strayChunks(ctx: BucketContext, _id: ObjectId): ConflictError {
	return new ConflictError(
		`putOnce: "${ctx.name}" holds chunks under _id ${String(_id)} that no ` +
			'file claims — chunk 0 was free and a later one was not. They are ' +
			'what an interrupted write leaves: remove them, or retry.',
		{ collection: ctx.definition.collections.chunks, id: _id },
	);
}

function otherBytes(ctx: BucketContext, _id: ObjectId): ConflictError {
	return new ConflictError(
		`putOnce: "${ctx.name}" already has a different file under _id ` +
			`${String(_id)}, whose digest begins the same way. Store these ` +
			'bytes with `put`.',
		{ collection: ctx.definition.collections.files, id: _id },
	);
}

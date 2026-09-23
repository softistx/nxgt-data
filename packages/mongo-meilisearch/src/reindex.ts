import type { ResumeToken } from '@nxgt/mongo';
import { MeilisearchApiError } from 'meilisearch';
import { deleteIds, sendDocuments } from './batch';
import type { Doc, SyncContext } from './context';
import { entryOf, keyOf } from './documents';
import { failed } from './errors';
import { withLease } from './lease';
import { checkIdle } from './running';
import { saveState } from './state';
import type { ReindexReport } from './types';

/**
 * Where the collection's changes are now, without waiting for one: a new
 * stream's first read answers with its position. The server holds that read
 * for up to `maxAwaitTimeMS` — a second by default, measured.
 */
async function currentToken(ctx: SyncContext): Promise<ResumeToken> {
	const stream = ctx.collection.raw.watch([], { maxAwaitTimeMS: 1 });
	try {
		await stream.tryNext();
		return stream.resumeToken as unknown as ResumeToken;
	} finally {
		await stream.close();
	}
}

/** Every live document through the transform, a page at a time. */
async function sendAll(ctx: SyncContext, wanted: Set<string>) {
	let indexed = 0;
	let skipped = 0;
	let after: string | null | undefined;
	do {
		const page = await ctx.collection.paginateByCursor({
			after,
			limit: ctx.pageSize,
		});
		const documents: Doc[] = [];
		for (const document of page.items as Doc[]) {
			const entry = await entryOf(ctx, document._id, document);
			if (entry.kind === 'delete') {
				skipped += 1;
				continue;
			}
			wanted.add(entry.key);
			documents.push(entry.document);
		}
		await sendDocuments(ctx, documents);
		indexed += documents.length;
		after = page.nextCursor;
	} while (after);
	return { indexed, skipped };
}

const LIST_LIMIT = 1000;

/** Nothing was ever written to it: an index that does not exist holds nothing. */
const missingIndex = (error: unknown) =>
	error instanceof MeilisearchApiError &&
	error.cause?.code === 'index_not_found';

/** Takes out what the index holds and the collection no longer gives it. */
async function removeUnwanted(
	ctx: SyncContext,
	wanted: Set<string>,
): Promise<number> {
	const unwanted: unknown[] = [];
	for (let offset = 0; ; offset += LIST_LIMIT) {
		const page = await ctx.index.raw
			.getDocuments({ fields: [ctx.primaryKey], limit: LIST_LIMIT, offset })
			.catch((error: unknown) => {
				if (missingIndex(error)) return undefined;
				throw error;
			});
		if (!page) return 0;
		for (const document of page.results as Doc[]) {
			const id = document[ctx.primaryKey];
			if (!wanted.has(keyOf(id))) unwanted.push(id);
		}
		if (offset + LIST_LIMIT >= page.total) break;
	}
	await deleteIds(ctx, unwanted);
	return unwanted.length;
}

/**
 * A reindex, holding the sync's lease for as long as it runs: a follower in
 * another process would otherwise have what it just indexed removed, and
 * never send it again.
 */
export async function reindex(ctx: SyncContext): Promise<ReindexReport> {
	checkIdle(ctx, 'reindex');
	return withLease(ctx, 'reindex', () => reindexHeld(ctx));
}

/** A reindex by a caller that already holds the lease: `start`. */
export async function reindexHeld(ctx: SyncContext): Promise<ReindexReport> {
	try {
		// Taken first: a change made while the documents are read is followed
		// again from here, so it cannot fall between the two.
		const token = await currentToken(ctx);
		const wanted = new Set<string>();
		const { indexed, skipped } = await sendAll(ctx, wanted);
		const removed = await removeUnwanted(ctx, wanted);
		await saveState(ctx, token, true);
		return { indexed, skipped, removed };
	} catch (error) {
		throw failed(ctx.name, 'reindexing', error);
	}
}

import { MeilisearchApiError } from 'meilisearch';
import { deleteIds, sendDocuments } from './batch';
import { type Doc, positive, type SyncContext } from './context';
import { entryOf, keyOf } from './documents';
import { failed } from './errors';
import type { ReindexOptions, ReindexReport } from './types';

/** Every row the repository pages through, transformed and sent. */
async function sendAll(
	ctx: SyncContext,
	pageSize: number,
	wanted: Set<string>,
	onPage: ReindexOptions['onPage'],
) {
	let pages = 0;
	let indexed = 0;
	let skipped = 0;
	let after: string | null | undefined;
	do {
		const page = await ctx.repository.paginateByCursor({
			after,
			limit: pageSize,
		});
		const documents: Doc[] = [];
		for (const row of page.items) {
			const entry = await entryOf(ctx, row);
			if (entry.kind === 'delete') {
				skipped += 1;
				continue;
			}
			wanted.add(entry.key);
			documents.push(entry.document);
		}
		await sendDocuments(ctx, documents, true);
		indexed += documents.length;
		pages += 1;
		await onPage?.({ pages, indexed, skipped });
		after = page.nextCursor;
	} while (after);
	return { indexed, skipped };
}

const LIST_LIMIT = 1000;

/** Nothing was ever written to it: an index that does not exist holds nothing. */
const missingIndex = (error: unknown) =>
	error instanceof MeilisearchApiError &&
	error.cause?.code === 'index_not_found';

/** Takes out what the index holds and the table no longer gives it. */
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
	await deleteIds(ctx, unwanted, true);
	return unwanted.length;
}

/**
 * Sends every row, then takes out what is left over.
 *
 * Each batch is waited for, and so is the last delete: what `removeUnwanted`
 * takes out is decided by reading the index back, and a document Meilisearch
 * has not applied yet would read as absent — and be removed a moment after
 * it was added.
 *
 * A row written while this runs is not seen by it unless the page it belongs
 * to has not been read yet. That is what `indexRow` is for: nothing here
 * follows the table.
 */
export async function reindex(
	ctx: SyncContext,
	options: ReindexOptions = {},
): Promise<ReindexReport> {
	const pageSize = positive(
		`reindexAll on "${ctx.name}"`,
		'pageSize',
		options.pageSize,
		ctx.pageSize,
	);
	try {
		const wanted = new Set<string>();
		const { indexed, skipped } = await sendAll(
			ctx,
			pageSize,
			wanted,
			options.onPage,
		);
		const removed = await removeUnwanted(ctx, wanted);
		return { indexed, skipped, removed };
	} catch (error) {
		throw failed(ctx.name, 'reindexing', error);
	}
}

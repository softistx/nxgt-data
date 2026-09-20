import type { Doc, SyncContext } from './context';
import type { Entry } from './documents';

/**
 * How long a write may take to be applied, when one is waited for.
 * Meilisearch's own default is five seconds, which a batch on a large index
 * outlasts.
 */
const WAIT = { wait: { timeout: 120_000 } } as const;

/**
 * What to pass the index for a write. Without `wait`, the call returns as
 * soon as Meilisearch has enqueued the task: indexing there is asynchronous,
 * and a request that has just written a row should not hold its response
 * open for it.
 */
const writeOptions = (wait: boolean) => (wait ? WAIT : undefined);

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/** Adds documents, `batchSize` at a time. */
export async function sendDocuments(
	ctx: SyncContext,
	documents: readonly Doc[],
	wait: boolean,
): Promise<void> {
	for (const batch of chunks(documents, ctx.batchSize)) {
		await ctx.index.add(batch, writeOptions(wait));
	}
}

/** Deletes documents by id, `batchSize` at a time. */
export async function deleteIds(
	ctx: SyncContext,
	ids: readonly unknown[],
	wait: boolean,
): Promise<void> {
	for (const batch of chunks(ids, ctx.batchSize)) {
		await ctx.index.delete(batch, writeOptions(wait));
	}
}

/**
 * Applies entries: one per id, so adds and deletes touch different
 * documents and their order does not matter.
 */
export async function send(
	ctx: SyncContext,
	entries: readonly Entry[],
	wait: boolean,
): Promise<void> {
	const documents: Doc[] = [];
	const ids: unknown[] = [];
	for (const entry of entries) {
		if (entry.kind === 'upsert') documents.push(entry.document);
		else ids.push(entry.id);
	}
	await sendDocuments(ctx, documents, wait);
	await deleteIds(ctx, ids, wait);
}

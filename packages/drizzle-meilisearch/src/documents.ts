import type { Doc, SyncContext } from './context';
import { SearchSyncError } from './errors';

/** One document's fate in the index: sent, or taken out. */
export type Entry =
	| { kind: 'upsert'; key: string; document: Doc }
	| { kind: 'delete'; key: string; id: unknown };

/** An id as a key: `1` and `'1'` are different ids to Meilisearch. */
export const keyOf = (id: unknown) => `${typeof id}:${String(id)}`;

const isRecord = (value: unknown): value is Doc =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a transform gave back, for a message: its shape, never its value. */
function describe(value: unknown): string {
	if (Array.isArray(value)) return 'an array';
	if (value === undefined) return 'undefined';
	return `a ${typeof value}`;
}

/**
 * What the index should hold for a row: what the transform makes of it, or
 * nothing when the transform keeps it out.
 */
export async function entryOf(ctx: SyncContext, row: Doc): Promise<Entry> {
	const id = ctx.toIndexId(row);
	const key = keyOf(id);
	const indexed = await ctx.transform(row);
	if (indexed === null) return { kind: 'delete', key, id };
	if (!isRecord(indexed)) {
		// A `SearchSyncError` with a code of its own, like the id mismatch
		// below it: a bare `TypeError` came back through `failed()` as
		// `FAILED`, the code that means "anything else", and named neither the
		// sync nor the row whose transform did it.
		throw new SearchSyncError(
			`Search sync "${ctx.name}": transform gave ${describe(indexed)} for ` +
				`the row ${String(id)}. It must give a document to index, or null ` +
				'to keep it out.',
			{ code: 'NOT_A_DOCUMENT', sync: ctx.name },
		);
	}
	const given = indexed[ctx.primaryKey];
	if (keyOf(given) !== key) {
		throw new SearchSyncError(
			`Search sync "${ctx.name}": transform gave "${ctx.primaryKey}" ` +
				`${JSON.stringify(given)} for the row whose index id is ` +
				`${JSON.stringify(id)}. A document under another id could never be ` +
				'taken out of the index again.',
			{ code: 'ID_MISMATCH', sync: ctx.name },
		);
	}
	return { kind: 'upsert', key, document: indexed };
}

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

/**
 * What the index should hold for a document of the collection: what the
 * transform makes of it, or nothing when it is gone or kept out.
 */
export async function entryOf(
	ctx: SyncContext,
	mongoId: unknown,
	document: Doc | undefined,
): Promise<Entry> {
	const id = ctx.toIndexId(mongoId);
	const key = keyOf(id);
	if (!document) return { kind: 'delete', key, id };
	const indexed = await ctx.transform(document);
	if (indexed === null) return { kind: 'delete', key, id };
	if (!isRecord(indexed)) {
		throw new TypeError(
			`transform must return a document or null, not ${String(indexed)}`,
		);
	}
	const given = indexed[ctx.primaryKey];
	if (keyOf(given) !== key) {
		throw new SearchSyncError(
			`Search sync "${ctx.name}": transform gave "${ctx.primaryKey}" ` +
				`${JSON.stringify(given)} for the document ${String(mongoId)}, whose ` +
				`index id is ${JSON.stringify(id)}. A document under another id ` +
				'could never be taken out of the index again.',
			{ code: 'ID_MISMATCH', sync: ctx.name },
		);
	}
	return { kind: 'upsert', key, document: indexed };
}

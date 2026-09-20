import { deleteIds, send } from './batch';
import type { Doc, SyncContext } from './context';
import { type Entry, entryOf } from './documents';
import { failed } from './errors';
import type { IndexWriteOptions } from './types';

const waits = (options: IndexWriteOptions | undefined) =>
	options?.wait ?? false;

/** Rows as the index should hold them, after a write to the table. */
export async function indexRows(
	ctx: SyncContext,
	rows: readonly Doc[],
	options?: IndexWriteOptions,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		// Keyed by index id, last one wins. `send` adds every document and
		// then deletes every id, which is only safe while no id is on both
		// sides: two states of one row in the same call — a caller batching
		// its writes can hand them over — would otherwise delete the document
		// the same call had just added. `@nxgt/mongo-meilisearch` gets this
		// from the `Map` its follower buffers into; here the list is the
		// caller's, so the dedup belongs on this side.
		const entries = new Map<string, Entry>();
		for (const row of rows) {
			const entry = await entryOf(ctx, row);
			entries.set(entry.key, entry);
		}
		await send(ctx, [...entries.values()], waits(options));
	} catch (error) {
		throw failed(ctx.name, 'indexing rows', error);
	}
}

/** Ids out of the index, for rows that are gone. */
export async function removeIds(
	ctx: SyncContext,
	ids: readonly unknown[],
	options?: IndexWriteOptions,
): Promise<void> {
	if (ids.length === 0) return;
	try {
		await deleteIds(ctx, ids, waits(options));
	} catch (error) {
		throw failed(ctx.name, 'removing documents', error);
	}
}

/** The index ids of rows, for a `delete` or a `hardDelete` that gave them back. */
export function idsOf(ctx: SyncContext, rows: readonly Doc[]): unknown[] {
	try {
		return rows.map((row) => ctx.toIndexId(row));
	} catch (error) {
		throw failed(ctx.name, 'reading an index id', error);
	}
}

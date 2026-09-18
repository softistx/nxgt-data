import {
	type SyncOptions,
	type SyncReport,
	syncCollections,
} from '@nxgt/mongo';
import type { KitContext } from './context';

/**
 * Syncs exactly the collections the kit wires, database by database — which
 * `syncAll` cannot do, since the registry knows no database.
 *
 * A deployment step: `collMod` needs the `dbAdmin` role, and neither it nor
 * an index build runs in a transaction. The first database that throws stops
 * the rest, so a `dryRun` is the way to see everything at once.
 */
export async function syncKit(
	ctx: KitContext,
	options: SyncOptions = {},
): Promise<Record<string, SyncReport[]>> {
	const reports: Record<string, SyncReport[]> = {};
	for (const database of ctx.databases) {
		reports[database.name] = await syncCollections(
			database.db,
			database.wired.map(([, definition]) => definition),
			options,
		);
	}
	return reports;
}

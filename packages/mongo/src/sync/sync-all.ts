import type { Db } from 'mongodb';
import { registeredCollections } from './registry';
import {
	type SyncOptions,
	type SyncReport,
	syncCollections,
} from './sync-collection';

/**
 * Syncs every collection `defineCollection` has built, in the order they were
 * defined, and says what it changed.
 *
 * There is no list to keep: importing the module that defines a collection is
 * what puts it in the registry, so this covers exactly the collections the
 * application actually loads.
 *
 * ```ts
 * import './collections';           // the definitions
 * const reports = await syncAll(db);
 * ```
 *
 * A deployment step, like `syncCollection`: `collMod` needs the `dbAdmin`
 * role, and neither it nor an index build may run in a transaction. The first
 * collection that throws stops the rest, so a dry run is the way to see
 * everything that is wrong at once.
 */
export function syncAll(
	db: Db,
	options: SyncOptions = {},
): Promise<SyncReport[]> {
	return syncCollections(db, registeredCollections(), options);
}

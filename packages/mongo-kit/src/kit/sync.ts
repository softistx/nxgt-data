import {
	type SyncOptions,
	type SyncReport,
	syncCollections,
} from '@nxgt/mongo';
import { type BucketIndexReport, getFiles } from '@nxgt/mongo/gridfs';
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

/**
 * Creates the four indexes each wired bucket needs, database by database,
 * and reports each bucket under its key. `sync` does not: a bucket is not a
 * collection definition, and `syncCollections` knows only those.
 *
 * Outside the kit's session, as `syncKit` is: mongod refuses `createIndexes`
 * in a transaction, and this is a deployment step, not part of a request.
 * The first database that throws stops the rest. There is no `dryRun`: the
 * bucket's own `syncIndexes` has none to pass on.
 */
export async function syncKitBuckets(
	ctx: KitContext,
): Promise<Record<string, Record<string, BucketIndexReport[]>>> {
	const reports: Record<string, Record<string, BucketIndexReport[]>> = {};
	for (const database of ctx.databases) {
		const byKey: Record<string, BucketIndexReport[]> = {};
		for (const [key, definition] of database.buckets) {
			byKey[key] = await getFiles(
				database.db,
				definition,
				database.bucketOptions,
			).syncIndexes();
		}
		reports[database.name] = byKey;
	}
	return reports;
}

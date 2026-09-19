import type { Db } from 'mongodb';
import { CHUNK_INDEX } from './chunks';
import type { BucketContext } from './context';
import { run } from './context';
import { HASH_KEY } from './handle';

/** What `syncIndexes` did, per collection. */
export interface BucketIndexReport {
	collection: string;
	created: string[];
	existing: string[];
}

/**
 * The indexes a bucket needs, created if they are not there.
 *
 * All four, because **nothing else creates any of them**. MongoDB's own
 * driver creates `filename_1_uploadDate_1` and `files_id_1_n_1` on the first
 * upload — measured on mongodb 7.6.0 — but this package does not upload
 * through it: `GridFSBucket` takes no session, so the chunks are written
 * here, and that safety net went with it. Until this has run, every read is a
 * scan of the whole chunks collection, and the documents examined grow with
 * the size of the **bucket** rather than of the file.
 *
 * It runs in the bucket's session like everything else, which means mongod
 * refuses it inside a transaction — loudly, which is the point. Create the
 * indexes at start-up, or bind with `autoSync`. `putOnce` is the exception
 * that creates them for itself, session dropped: the unique
 * `{ files_id, n }` index is half of how it elects between two callers, so
 * it is not a bucket option's to withhold.
 */
export async function syncBucketIndexes(
	ctx: BucketContext,
): Promise<BucketIndexReport[]> {
	return [
		await ensure(ctx, ctx.definition.collections.files, [
			{ key: { uploadDate: -1, _id: -1 }, name: 'nxgt_uploadDate_id' },
			{
				key: { [`metadata.${HASH_KEY}`]: 1 },
				name: 'nxgt_sha256',
				// Most buckets store a digest; one bound with `hash: false`
				// stores none, and a sparse index leaves those files out of it.
				sparse: true,
			},
			{ key: { filename: 1, uploadDate: 1 }, name: 'filename_1_uploadDate_1' },
		]),
		await ensure(ctx, ctx.definition.collections.chunks, [
			// Unique, as the GridFS specification asks: it is what stops two
			// writers landing two chunk 3s under one file.
			{ key: { files_id: 1, n: 1 }, name: CHUNK_INDEX, unique: true },
		]),
	];
}

/**
 * The syncs `autoSync` has started, per database and per bucket, so that every
 * bucket of the same database waits on the same one — including the ones
 * `withSession` builds, which are the same bucket again.
 *
 * A sync that failed is forgotten, so the next call tries again.
 */
let syncs = new WeakMap<Db, Map<string, Promise<unknown>>>();

/**
 * Forgets the index syncs `autoSync` has already run, for one database or for
 * all.
 *
 * The memo outlives the bucket itself, so `drop()` calls this for the
 * database it emptied: what a process remembers creating has to stop being
 * true when the collections go, or `putOnce` elects on an index that is no
 * longer there. A test that empties its database another way — dropping it
 * outright — calls this itself, alongside `resetAutoSync`.
 */
export function resetBucketSync(db?: Db): void {
	if (db) syncs.delete(db);
	else syncs = new WeakMap();
}

/**
 * The indexes, created once per database and bucket for the life of the
 * process — by `autoSync`, and by `putOnce`, which needs one of them to
 * elect between two callers and so does not leave it to a bucket option.
 */
export function syncBucketIndexesOnce(ctx: BucketContext): Promise<unknown> {
	let byName = syncs.get(ctx.db);
	if (!byName) {
		byName = new Map();
		syncs.set(ctx.db, byName);
	}
	const started = byName.get(ctx.name);
	if (started) return started;
	// Without the session: `autoSync` fires on whichever call happens to be
	// first, and mongod refuses `createIndexes` inside a transaction. A bucket
	// whose first use is in a transaction would otherwise fail that
	// transaction for a reason that has nothing to do with it.
	const running = syncBucketIndexes({ ...ctx, sessionOption: {} });
	byName.set(ctx.name, running);
	running.catch(() => byName.delete(ctx.name));
	return running;
}

async function ensure(
	ctx: BucketContext,
	collection: string,
	wanted: {
		key: Record<string, 1 | -1>;
		name: string;
		unique?: boolean;
		sparse?: boolean;
	}[],
): Promise<BucketIndexReport> {
	const target = ctx.db.collection(collection);
	const present = await run(
		ctx,
		async () => {
			try {
				return (await target.indexes(ctx.sessionOption)).map(
					(index) => index.name,
				);
			} catch (error) {
				// The collection is not there yet, which is not a failure: an
				// index on a collection that does not exist creates it. 26 is
				// `NamespaceNotFound`, and nothing else is swallowed — an auth
				// failure read as "no indexes" would try to build all four.
				if ((error as { code?: unknown }).code !== 26) throw error;
				return [];
			}
		},
		collection,
	);
	const created: string[] = [];
	const existing: string[] = [];
	for (const index of wanted) {
		if (present.includes(index.name)) {
			existing.push(index.name);
			continue;
		}
		await run(
			ctx,
			() =>
				target.createIndex(index.key, {
					...ctx.sessionOption,
					name: index.name,
					...(index.unique ? { unique: true } : {}),
					...(index.sparse ? { sparse: true } : {}),
				}),
			collection,
		);
		created.push(index.name);
	}
	return { collection, created, existing };
}

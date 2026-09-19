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
 * MongoDB's own driver creates `filename_1_uploadDate_1` and
 * `files_id_1_n_1` on the **first upload** — measured on mongodb 7.6.0 — and
 * not before, so a bucket that has never been written to has none of them and
 * a first read scans. These two are this package's own: the pagination order,
 * and the digest `putOnce` looks a file up by.
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
			{ key: { files_id: 1, n: 1 }, name: 'files_id_1_n_1', unique: true },
		]),
	];
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
	const present = await run(ctx, async () => {
		try {
			return (await target.indexes()).map((index) => index.name);
		} catch {
			// The collection is not there yet, which is not a failure: an
			// index on a collection that does not exist creates it.
			return [];
		}
	});
	const created: string[] = [];
	const existing: string[] = [];
	for (const index of wanted) {
		if (present.includes(index.name)) {
			existing.push(index.name);
			continue;
		}
		await run(ctx, () =>
			target.createIndex(index.key, {
				name: index.name,
				...(index.unique ? { unique: true } : {}),
				...(index.sparse ? { sparse: true } : {}),
			}),
		);
		created.push(index.name);
	}
	return { collection, created, existing };
}

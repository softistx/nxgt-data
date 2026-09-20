import type { Db } from 'mongodb';
import type { BucketContext } from './context';
import { run } from './context';
import { HASH_KEY } from './keys';

/**
 * The unique index GridFS requires, by the name the server reports it under.
 *
 * It lives here rather than beside the chunk writes because it is not only an
 * index: it is what refuses the second of two writers reaching for the same
 * chunk of the same file, which is half of how `putOnce` elects between them,
 * and this module is what creates it. Its readers are this file and
 * `operations/claim.ts`; `chunks.ts` does not read it.
 */
export const CHUNK_INDEX = 'files_id_1_n_1';

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
 * The buckets already probed for the chunk index, as `<database>:<bucket>`.
 *
 * By **name**, not by the `Db` object the way `syncs` above is: measured on
 * mongodb 7.6.0, `client.db('app') !== client.db('app')` — the driver builds
 * a new `Db` on every call and caches none. An application that writes
 * `getFiles(client.db('app'), uploads)` per request — the shape this package
 * invites, since `connectMongo` shares the client and not the `Db` — would
 * have been told once per request rather than once per process. On `syncs`
 * the same identity costs one redundant, idempotent `createIndexes`; on a
 * warning it is noise in a package whose contract is that nothing here logs.
 *
 * A `Set` and not a `WeakMap`, so it holds no `Db` at all. One entry per
 * bucket per process is a handful of short strings.
 */
const probes = new Set<string>();

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

/**
 * Says once, on a `process` warning, that a bucket has no chunk index.
 *
 * Without `files_id_1_n_1`, reading one file's bytes examines every chunk
 * document of the bucket: the cost grows with the bucket rather than with the
 * file, and **nothing else says so** — the read works, it is only slow, and a
 * bucket that was never synced looks exactly like one that was until it holds
 * enough files to hurt. A bucket bound with `autoSync`, or an application that
 * calls `syncIndexes()` at start-up, never sees this.
 *
 * `process.emitWarning` rather than a logger or `console.warn`: it is the one
 * channel every application already has, and it can be listened to or
 * silenced without this package taking an opinion on logging. Measured on bun
 * 1.4.2: a `process.on('warning')` listener receives it, carrying the `code`
 * below, and Bun prints it as well.
 *
 * It never throws and never delays a read: the probe runs beside the read,
 * and a probe that fails is forgotten so the next read tries again — the
 * bucket may not have been readable yet, and nothing here is worth failing a
 * read over. Once per database and bucket for the life of the process: see
 * `probes`, and why it is keyed by name.
 */
export function warnIfChunksUnindexed(ctx: BucketContext): void {
	// This process created them itself: there is nothing to probe for.
	if (syncs.get(ctx.db)?.has(ctx.name)) return;
	const seen = `${ctx.db.databaseName}:${ctx.name}`;
	if (probes.has(seen)) return;
	// Added before the await, so two reads racing here probe once.
	probes.add(seen);
	void probe(ctx).catch(() => probes.delete(seen));
}

async function probe(ctx: BucketContext): Promise<void> {
	const chunks = ctx.definition.collections.chunks;
	// Without the session, like `syncBucketIndexesOnce`: a read inside a
	// transaction must not have a listing of its own attached to it.
	const present = await ctx.db.collection(chunks).indexes();
	if (present.some((index) => index.name === CHUNK_INDEX)) return;
	process.emitWarning(
		`Bucket "${ctx.name}" has no ${CHUNK_INDEX} on "${chunks}": every read ` +
			'scans the whole collection, and the cost grows with the bucket ' +
			'rather than with the file. Call syncIndexes() at start-up, or bind ' +
			'with autoSync.',
		{ code: 'NxgtGridFSMissingIndex' },
	);
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

import type {
	ClientSession,
	Collection,
	Db,
	Document,
	GridFSBucket,
} from 'mongodb';
import type { CursorPage } from '../pagination/page';
import {
	type BucketContext,
	type BucketOptions,
	bucketContext,
	run,
} from './context';
import type { FileHandle, ResponseInit } from './handle';
import {
	type BucketIndexReport,
	syncBucketIndexes,
	syncBucketIndexesOnce,
} from './indexes';
import { type FilePageOptions, paginateFiles } from './operations/paginate';
import { fileExists, findFile, getFile } from './operations/reads';
import {
	deleteFile,
	type PutOnceResult,
	type PutOptions,
	putFile,
	putFileOnce,
	renameFile,
} from './operations/writes';
import { serveFile } from './serve';
import type { FileSource } from './source';
import type { BucketDefinition, FileId, MetadataAsGiven } from './types';

/** What a write may say about a file, typed by the bucket's metadata schema. */
export interface TypedPutOptions<Def> extends Omit<PutOptions, 'metadata'> {
	metadata?: MetadataAsGiven<Def>;
}

/** A bucket, bound to a database. */
export interface TypedBucket<Def extends BucketDefinition> {
	readonly name: string;
	readonly definition: Def;
	/** The driver's own bucket, for whatever this does not cover. */
	readonly raw: GridFSBucket;
	readonly session: ClientSession | undefined;

	/** Writes a file and gives back the handle to it. */
	put(
		source: FileSource,
		options?: TypedPutOptions<Def>,
	): Promise<FileHandle<Def>>;
	/**
	 * The same, unless the bucket already holds these very bytes: then the
	 * file that was already there is given back, and `stored` is `false`.
	 */
	putOnce(
		source: FileSource,
		options?: TypedPutOptions<Def>,
	): Promise<PutOnceResult & { file: FileHandle<Def> }>;

	/** The file, or `NotFoundError`. Nothing is read until you ask for bytes. */
	get(id: FileId): Promise<FileHandle<Def>>;
	/** The file, or `undefined`. */
	find(id: FileId): Promise<FileHandle<Def> | undefined>;
	exists(id: FileId): Promise<boolean>;

	delete(id: FileId): Promise<void>;
	rename(id: FileId, filename: string): Promise<void>;

	/** One page of the bucket, newest first. */
	paginate(options?: FilePageOptions): Promise<CursorPage<FileHandle<Def>>>;

	/**
	 * The response for this request: the whole file, the range it asked for,
	 * `304` when it already has the bytes, or `404` when there is no such file.
	 */
	serve(request: Request, id: FileId, init?: ResponseInit): Promise<Response>;

	/**
	 * Creates the four indexes this bucket needs, if they are not there.
	 *
	 * Nothing else creates any of them, so until this has run every read is a
	 * scan. Call it at start-up, or bind the bucket with `autoSync`. It runs
	 * in the bucket's session like every other call, which means mongod
	 * refuses it inside a transaction.
	 */
	syncIndexes(): Promise<BucketIndexReport[]>;
	/**
	 * Removes every file in the bucket, and both its collections. A bucket
	 * that is not there is not an error; anything else is.
	 */
	drop(): Promise<void>;

	/** The same bucket, every call of it running in this session. */
	withSession(session: ClientSession | undefined): TypedBucket<Def>;
}

/**
 * A bucket, bound to a database.
 *
 * ```ts
 * const avatars = getFiles(db, avatarsBucket);
 * const file = await avatars.put(Bun.file('ada.png'), {
 * 	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90' },
 * });
 * return await avatars.serve(request, file.id);
 * ```
 */
export function getFiles<Def extends BucketDefinition>(
	db: Db,
	definition: Def,
	options: BucketOptions = {},
): TypedBucket<Def> {
	const ctx = bucketContext(db, definition, options);
	const api = bound(ctx, definition, db, options);
	return options.autoSync === true ? gated(ctx, api) : api;
}

/**
 * What does not wait for `autoSync`: the properties, the one that builds
 * another bucket, and the two that are about the indexes themselves.
 */
const UNGATED = new Set([
	'name',
	'definition',
	'raw',
	'session',
	'withSession',
	'syncIndexes',
	'drop',
]);

/** Every call of the bucket, made to create the indexes first. */
function gated<Def extends BucketDefinition>(
	ctx: BucketContext,
	api: TypedBucket<Def>,
): TypedBucket<Def> {
	// A `Proxy`, as `get-collection.ts` gates a collection: it keeps the type
	// and needs no cast to put it back.
	return new Proxy(api, {
		get(target, key, receiver) {
			const own = Reflect.get(target, key, receiver);
			if (typeof own !== 'function' || UNGATED.has(key as string)) return own;
			return (...args: unknown[]) =>
				syncBucketIndexesOnce(ctx).then(() =>
					(own as (...a: unknown[]) => unknown)(...args),
				);
		},
	});
}

function bound<Def extends BucketDefinition>(
	ctx: BucketContext,
	definition: Def,
	db: Db,
	options: BucketOptions,
): TypedBucket<Def> {
	type Handle = FileHandle<Def>;
	return {
		name: ctx.name,
		definition,
		raw: ctx.bucket,
		session: ctx.session,

		put: (source, putOptions) =>
			putFile(ctx, source, putOptions as PutOptions) as Promise<Handle>,
		putOnce: (source, putOptions) =>
			putFileOnce(ctx, source, putOptions as PutOptions) as Promise<
				PutOnceResult & { file: Handle }
			>,

		get: (id) => getFile(ctx, id) as Promise<Handle>,
		find: (id) => findFile(ctx, id) as Promise<Handle | undefined>,
		exists: (id) => fileExists(ctx, id),

		delete: (id) => deleteFile(ctx, id),
		rename: (id, filename) => renameFile(ctx, id, filename),

		paginate: (pageOptions) =>
			paginateFiles(ctx, pageOptions) as Promise<CursorPage<Handle>>,

		serve: async (request, id, init) => {
			const file = await findFile(ctx, id);
			if (!file) {
				return new Response(null, { status: 404 });
			}
			return serveFile(file, request, init);
		},

		syncIndexes: () => syncBucketIndexes(ctx),
		drop: async () => {
			await dropCollection(ctx, ctx.files, ctx.definition.collections.files);
			await dropCollection(ctx, ctx.chunks, ctx.definition.collections.chunks);
		},

		// Through `getFiles`, so that an `autoSync` bucket stays one: a session
		// is not a reason to stop creating the indexes.
		withSession: (session) => getFiles(db, definition, { ...options, session }),
	};
}

/**
 * Drops one of the bucket's two collections.
 *
 * Only "there is no such collection" is swallowed: catching everything made a
 * drop the server **refused** — inside a transaction, or without the right —
 * indistinguishable from one that worked.
 */
async function dropCollection(
	ctx: BucketContext,
	collection: Collection<Document>,
	name: string,
): Promise<void> {
	await run(
		ctx,
		async () => {
			try {
				await collection.drop(ctx.sessionOption);
			} catch (error) {
				// 26 is `NamespaceNotFound`.
				if ((error as { code?: unknown }).code !== 26) throw error;
			}
		},
		name,
	);
}

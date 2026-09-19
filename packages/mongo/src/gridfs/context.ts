import type { ClientSession, Collection, Db, Document } from 'mongodb';
import { GridFSBucket } from 'mongodb';
import type { z } from 'zod';
import { type FieldKinds, kindsOf } from '../collection/coerce';
import { NotFoundError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import type { BucketDefinition } from './types';

/** How a bound bucket behaves, beside what the definition already says. */
export interface BucketOptions {
	/**
	 * `'parse'`, the default, checks metadata against the schema on every
	 * write. `'off'` sends it as it is — for a migration, or a backfill that
	 * has already been checked.
	 */
	validate?: 'parse' | 'off';
	/** Reads the strings that arrive from outside as ids and dates. Default on. */
	coerce?: boolean;
	/**
	 * Hashes every upload as it streams, and stores the digest. Default on:
	 * it is what `putOnce` compares and what an `ETag` is built from, and it
	 * costs one pass over bytes that are being sent over a socket anyway.
	 */
	hash?: boolean;
	/** The session every read and write of this bucket runs in. */
	session?: ClientSession;
}

/** Everything a bucket operation needs, and nothing it does. */
export interface BucketContext {
	readonly db: Db;
	readonly definition: BucketDefinition;
	readonly name: string;
	readonly bucket: GridFSBucket;
	readonly files: Collection<Document>;
	readonly chunks: Collection<Document>;
	/** The metadata schema's fields, or `{}` when the bucket declares none. */
	readonly shape: Record<string, z.ZodType>;
	readonly kinds: FieldKinds;
	readonly parses: boolean;
	readonly coerces: boolean;
	readonly hashes: boolean;
	readonly session: ClientSession | undefined;
	/** Spread into every driver call, so a session is never forgotten. */
	readonly sessionOption: { session?: ClientSession };
}

export function bucketContext(
	db: Db,
	definition: BucketDefinition,
	options: BucketOptions = {},
): BucketContext {
	const shape = (definition.metadata?.shape ?? {}) as Record<string, z.ZodType>;
	const coerces = options.coerce ?? true;
	const { session } = options;
	return Object.freeze({
		db,
		definition,
		name: definition.name,
		bucket: new GridFSBucket(db, {
			bucketName: definition.name,
			...(definition.chunkSize === undefined
				? {}
				: { chunkSizeBytes: definition.chunkSize }),
		}),
		files: db.collection(definition.collections.files),
		chunks: db.collection(definition.collections.chunks),
		shape,
		kinds: coerces ? kindsOf(shape) : {},
		parses: (options.validate ?? 'parse') === 'parse',
		coerces,
		hashes: options.hash ?? true,
		session,
		sessionOption: Object.freeze(session ? { session } : {}),
	});
}

/** Every call to the driver goes through here, so every failure is ours. */
export async function run<T>(
	ctx: BucketContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDataError(error, { collection: ctx.definition.collections.files });
	}
}

export function noSuchFile(ctx: BucketContext, id: unknown): NotFoundError {
	return new NotFoundError(`No file in "${ctx.name}" with _id ${String(id)}`, {
		collection: ctx.definition.collections.files,
		id,
	});
}

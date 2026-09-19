import type { ObjectId } from 'mongodb';
import type { z } from 'zod';
import type { AsGiven } from '../collection/coerce';

/** A metadata schema: an object, as a collection's schema is. */
export type MetadataSchema = z.ZodObject;

/** What `defineBucket` is given. */
export interface BucketConfig<M extends MetadataSchema | undefined> {
	/**
	 * The bucket's name. GridFS keeps two collections under it, `<name>.files`
	 * and `<name>.chunks`, which is why this is a name and not a collection.
	 */
	name: string;
	/**
	 * What the metadata of a file in this bucket looks like. Checked on every
	 * write, typed on every read, and the strings that arrive from outside are
	 * read as the fields they are — an id and a date, exactly as a collection
	 * reads them.
	 */
	metadata?: M;
	/**
	 * The size of a chunk, in bytes. MongoDB's own default is 255 KiB, and a
	 * bucket that serves ranges out of large files reads fewer documents with
	 * a larger one.
	 */
	chunkSize?: number;
}

/** A bucket, described once and used everywhere. */
export interface BucketDefinition<
	M extends MetadataSchema | undefined = MetadataSchema | undefined,
> {
	readonly name: string;
	readonly metadata: M;
	readonly chunkSize: number | undefined;
	/** The two collections GridFS keeps, by their full names. */
	readonly collections: { readonly files: string; readonly chunks: string };
}

/** The metadata a file of this bucket carries, as it is **read**. */
export type MetadataOf<Def> =
	Def extends BucketDefinition<infer M>
		? M extends MetadataSchema
			? z.output<M>
			: Record<string, unknown>
		: never;

/** The metadata as it may be **given**: an id or a date may be a string. */
export type MetadataAsGiven<Def> =
	Def extends BucketDefinition<infer M>
		? M extends MetadataSchema
			? AsGiven<z.input<M>>
			: Record<string, unknown>
		: never;

/** An id as a caller may hold it: the stored form, or its 24 hex characters. */
export type FileId = ObjectId | string;

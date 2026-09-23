import { S3Client, type S3File, type S3Options, type S3Stats } from 'bun';
import { bucketContext, keyOf } from './context';
import { listObjects } from './operations/list';
import {
	type PresignOptions,
	presignGetUrl,
	presignPutUrl,
} from './operations/presign';
import {
	type PresignedPost,
	type PresignPostOptions,
	presignPostForm,
} from './operations/presign-post';
import {
	objectExists,
	readBytes,
	readText,
	statObject,
} from './operations/reads';
import { deleteObject, putObject } from './operations/writes';
import type {
	BucketDefinition,
	ObjectPage,
	PutBody,
	PutOptions,
} from './types';

export type { PresignedPost, PresignOptions, PresignPostOptions };

/** A bucket bound to credentials: the definition, with somewhere to put it. */
export interface BoundBucket<P> {
	/** The client this holds, for anything this package does not wrap. */
	readonly client: S3Client;
	/** The key this would use, for a caller that needs the string itself. */
	keyFor(params: P): string;
	/** Bun's own lazy handle: `.stream()`, `.slice()`, `.writer()` and the rest. */
	file(params: P): S3File;
	/**
	 * Writes it, once the bucket's content type and size have accepted it.
	 *
	 * Beyond `type`, an option here describes **this object** — how it is
	 * served back (`contentDisposition`, `contentEncoding`), who may read it
	 * (`acl`), what it costs to keep (`storageClass`) — or how a large body is
	 * uploaded (`partSize`, `queueSize`, `retry`).
	 */
	put(params: P, body: PutBody, options?: PutOptions): Promise<void>;
	/** The bytes, or `undefined` when there is no such object. */
	bytes(params: P): Promise<Uint8Array | undefined>;
	/** The body as text, or `undefined` when there is no such object. */
	text(params: P): Promise<string | undefined>;
	exists(params: P): Promise<boolean>;
	/** What the service knows about it, or `undefined` when it is not there. */
	stat(params: P): Promise<S3Stats | undefined>;
	/** Removes it. S3 does not say whether anything was there, and nor does this. */
	delete(params: P): Promise<void>;
	/** One page of the bucket, in this repository's cursor shape. */
	list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string | null;
	}): Promise<ObjectPage>;
	/** A URL that reads this object, signed. */
	presignGet(params: P, options?: PresignOptions): string;
	/**
	 * A URL that writes this object, signed. It constrains the key and the
	 * deadline, and **nothing else** — not the size, not the content type.
	 */
	presignPut(params: P, options?: PresignOptions): string;
	/**
	 * The form a browser posts to upload this object, signed. Unlike
	 * `presignPut`, the **service** holds the upload to a size range and a
	 * content type — by default the bucket's own `maxSize` and single
	 * `contentType`. Post `fields` first and the file last.
	 */
	presignPost(params: P, options?: PresignPostOptions): PresignedPost;
}

/**
 * Binds a bucket definition to credentials.
 *
 * ```ts
 * const store = bindBucket(avatars, {
 * 	endpoint: process.env.S3_ENDPOINT,
 * 	accessKeyId: process.env.S3_KEY,
 * 	secretAccessKey: process.env.S3_SECRET,
 * });
 * await store.put({ userId: 'u1' }, png, { type: 'image/png' });
 * ```
 *
 * Given no options, Bun reads its own `S3_*` / `AWS_*` environment variables.
 *
 * Each bound bucket holds an `S3Client` of its own. S3 is stateless HTTP —
 * there is no connection to share, and nothing to close.
 */
export function bindBucket<P>(
	definition: BucketDefinition<P>,
	options: Omit<S3Options, 'bucket'> = {},
): BoundBucket<P> {
	const client = new S3Client({ ...options, bucket: definition.bucket });
	const context = bucketContext(client, definition, options.secretAccessKey);
	return {
		client,
		keyFor: (params) => keyOf(context, params),
		file: (params) => client.file(keyOf(context, params)),
		put: (params, body, putOptions) =>
			putObject(context, params, body, putOptions),
		bytes: (params) => readBytes(context, params),
		text: (params) => readText(context, params),
		exists: (params) => objectExists(context, params),
		stat: (params) => statObject(context, params),
		delete: (params) => deleteObject(context, params),
		list: (listOptions) => listObjects(context, listOptions),
		presignGet: (params, presignOptions) =>
			presignGetUrl(context, params, presignOptions),
		presignPut: (params, presignOptions) =>
			presignPutUrl(context, params, presignOptions),
		presignPost: (params, postOptions) =>
			presignPostForm(context, params, postOptions),
	};
}

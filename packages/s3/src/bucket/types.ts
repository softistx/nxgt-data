/**
 * One bucket: which one it is, how an object's key is built from the things
 * that identify it, and what this application is willing to put in it.
 *
 * The key is a **function**, not a template, so nothing is spelled by hand at
 * a call site and a renamed parameter is a compile error.
 */
export interface BucketDefinition<P> {
	/** The bucket's name on the service. */
	readonly bucket: string;
	/** The object's key, from whatever identifies it. */
	readonly key: (params: P) => string;
	/**
	 * The content types this bucket accepts. A write of anything else is
	 * refused **before it is sent**. Left out, anything goes.
	 */
	readonly contentType?: string | readonly string[];
	/**
	 * The biggest body this bucket accepts, in bytes, refused before it is
	 * sent. Left out, anything goes — see the Traps about bodies whose size
	 * cannot be known in advance.
	 */
	readonly maxSize?: number;
}

/** What a listing says about one object. */
export interface StoredObject {
	key: string;
	/** Bytes, or `undefined` when the service did not say. */
	size: number | undefined;
	lastModified: Date | undefined;
	eTag: string | undefined;
}

/**
 * One page of a listing. The same shape as the `CursorPage` of
 * `@nxgt/drizzle` and `@nxgt/mongo`, so a caller pages the same way here —
 * S3's `continuationToken` is what `nextCursor` carries.
 */
export interface ObjectPage {
	items: StoredObject[];
	/** Pass it as `cursor` for the next page; `null` on the last one. */
	nextCursor: string | null;
}

/** What a definition's `key` takes, so a caller can write its own helper. */
export type ParamsOf<D> = D extends BucketDefinition<infer P> ? P : never;

import type { S3Client, S3Options } from 'bun';

/**
 * Everything Bun's own `write` takes — a string, bytes, a `Blob`, a stream, a
 * `Response`. A bucket with a `maxSize` refuses the ones whose size cannot be
 * known before sending; one without accepts them all.
 */
export type PutBody = Parameters<S3Client['write']>[1];

/**
 * What a single write may say about **the object it stores**.
 *
 * Picked out of Bun's own `S3Options` rather than written again here, so a
 * Bun release that changes one of these is a compile error instead of a
 * silent drift.
 *
 * Only what describes the object is here. The credentials, the endpoint, the
 * bucket and the region belong to the bound bucket — naming them per write
 * would let one call store the object somewhere the definition never
 * described. `partSize`, `queueSize` and `retry` are not here either:
 * measured on bun 1.4.2 against a 12 MiB body, a `put` with `partSize` set
 * and one without produce the **same** ETag, with no `-<parts>` suffix — so
 * a single PUT either way, and offering them would promise a multipart
 * upload this package does not do. `bindBucket` still takes them, where they
 * are the client's own.
 *
 * `type` is the one the guards read — see `effectiveType`. The rest reach
 * the service untouched.
 */
export type PutOptions = Pick<
	S3Options,
	'type' | 'acl' | 'storageClass' | 'contentDisposition' | 'contentEncoding'
>;

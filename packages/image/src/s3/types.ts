import type { PresignGetOptions } from '@nxgt/s3';
import type { ImageInput } from '../input/read-input';
import type { ProcessOptions } from '../set/types';

/** One stored size. */
export type StoredVariant = {
	size: number;
	/** The object's key in the bucket. */
	key: string;
	width: number;
	height: number;
	contentType: 'image/webp';
	byteLength: number;
};

/** What `replace` stored. */
export type StoredImage = {
	/**
	 * 16 hex characters of the SHA-256 over the variants' bytes, in the order
	 * of the set's `sizes`: the same picture processed again gives the same
	 * version, so it can be a cache-busting query or an ETag.
	 */
	version: string;
	variants: StoredVariant[];
};

/** An image set bound to a bucket; `P` is the bucket's key parameters minus `size`. */
export type ImageStore<P> = {
	/**
	 * Processes the upload, then stores every size at `{ ...params, size }`.
	 *
	 * A `RangeError` or an `ImageError` from processing comes out before
	 * anything is written. If a put fails, the keys whose put was fulfilled are
	 * deleted (best effort) and the first put error is rethrown unchanged,
	 * "first" meaning first in the set's size order, not first in time. The key
	 * whose put was refused is never deleted: with fixed params an earlier
	 * object may sit there, and a refused put wrote nothing. A put that failed
	 * after sending (a network error) may still land later; with a fresh id per
	 * upload that leaves at worst an unreferenced object.
	 *
	 * Recommended pattern: `const imageId = crypto.randomUUID()`, `replace`
	 * under it, store the id, then `remove` the former id's set. With fixed
	 * params, a `replace` followed by removing the "former" image would delete
	 * the new one.
	 */
	replace(
		params: P,
		input: ImageInput,
		options?: ProcessOptions,
	): Promise<StoredImage>;
	/**
	 * Deletes every size of the set at `params`. A missing object is not an
	 * error.
	 */
	remove(params: P): Promise<void>;
	/** A signed URL for one size. A `size` outside the set is a `RangeError`. */
	presignGet(params: P, size: number, options?: PresignGetOptions): string;
	/** The bytes of one size, or `undefined` when missing. */
	bytes(params: P, size: number): Promise<Uint8Array | undefined>;
	/** The key of one size. A `size` outside the set is a `RangeError`. */
	keyFor(params: P, size: number): string;
};

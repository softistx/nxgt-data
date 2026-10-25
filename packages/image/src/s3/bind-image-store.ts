import type { BoundBucket } from '@nxgt/s3';
import type { ImageSet } from '../set/types';
import type { ImageStore, StoredImage } from './types';

/** The first 16 hex characters of the SHA-256 over the parts, in order. */
function versionOf(parts: readonly Uint8Array[]): string {
	const hasher = new Bun.CryptoHasher('sha256');
	for (const part of parts) hasher.update(part);
	return hasher.digest('hex').slice(0, 16);
}

/**
 * Binds an image set to a `@nxgt/s3` bucket whose key is built from the
 * params **and a `size`**.
 *
 * ```ts
 * const avatars = defineBucket({
 * 	bucket: 'avatars',
 * 	key: ({ imageId, size }: { imageId: string; size: number }) =>
 * 		`avatars/${imageId}/${size}.webp`,
 * });
 * const store = bindImageStore(defineImageSet(), bindBucket(avatars));
 * const imageId = crypto.randomUUID();
 * const { version } = await store.replace({ imageId }, await request.blob());
 * ```
 *
 * Objects are never public: puts pass only `type`, no `acl`, so bind the bucket
 * without a public default `acl` (Bun would send it on every put). Serve them
 * with `presignGet`. Use a fresh id per upload (see `ImageStore.replace`).
 */
export function bindImageStore<P extends { size: number }>(
	set: ImageSet,
	bucket: BoundBucket<P>,
): ImageStore<Omit<P, 'size'>> {
	const at = (call: string, params: Omit<P, 'size'>, size: number) => {
		if (!set.sizes.includes(size)) {
			throw new RangeError(
				`${call}: size ${size} is not one of the set's sizes (${set.sizes.join(', ')})`,
			);
		}
		return { ...params, size } as P;
	};
	const removeAll = (params: Omit<P, 'size'>) =>
		Promise.all(
			set.sizes.map((size) => bucket.delete(at('remove', params, size))),
		);

	return {
		async replace(params, input, options) {
			const { variants } = await set.process(input, options);
			const results = await Promise.allSettled(
				variants.map((v) =>
					bucket.put(at('replace', params, v.size), v.bytes, {
						type: 'image/webp',
					}),
				),
			);
			const failed = results.find((r) => r.status === 'rejected');
			if (failed) {
				// Best effort, and only what this call wrote: the keys whose put was
				// fulfilled. The refused one is never deleted, since an earlier object
				// may sit there (fixed params) and a refused put wrote nothing. A put
				// that failed after sending (a network error) may still land later;
				// with a fresh id per upload that leaves an unreferenced object.
				await Promise.allSettled(
					variants.flatMap((v, i) =>
						results[i]?.status === 'fulfilled'
							? [bucket.delete(at('replace', params, v.size))]
							: [],
					),
				);
				throw failed.reason;
			}
			return {
				version: versionOf(variants.map((v) => v.bytes)),
				variants: variants.map((v) => ({
					size: v.size,
					key: bucket.keyFor(at('replace', params, v.size)),
					width: v.width,
					height: v.height,
					contentType: v.contentType,
					byteLength: v.bytes.byteLength,
				})),
			} satisfies StoredImage;
		},
		async remove(params) {
			await removeAll(params);
		},
		presignGet: (params, size, options) =>
			bucket.presignGet(at('presignGet', params, size), options),
		async bytes(params, size) {
			return bucket.bytes(at('bytes', params, size));
		},
		keyFor: (params, size) => bucket.keyFor(at('keyFor', params, size)),
	};
}

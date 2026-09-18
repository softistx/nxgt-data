import type { BucketDefinition } from './types';

/**
 * Describes a bucket. It talks to nothing: `bindBucket` is what needs
 * credentials.
 *
 * ```ts
 * export const avatars = defineBucket({
 * 	bucket: 'avatars',
 * 	key: (p: { userId: string }) => `${p.userId}.png`,
 * 	contentType: ['image/png', 'image/jpeg'],
 * 	maxSize: 2 * 1024 * 1024,
 * });
 * ```
 */
export function defineBucket<P>(
	definition: BucketDefinition<P>,
): BucketDefinition<P> {
	if (definition.bucket.length === 0) {
		throw new TypeError('defineBucket: a bucket definition needs a bucket');
	}
	if (definition.maxSize !== undefined) {
		const { maxSize } = definition;
		if (!Number.isFinite(maxSize) || maxSize <= 0) {
			throw new TypeError(
				`defineBucket: "${definition.bucket}" has a maxSize of ${maxSize}; ` +
					'it is a number of bytes, and must be above zero',
			);
		}
	}
	const types = definition.contentType;
	if (Array.isArray(types) && types.length === 0) {
		throw new TypeError(
			`defineBucket: "${definition.bucket}" accepts an empty list of ` +
				'content types, so nothing could ever be written. Leave ' +
				'`contentType` out to accept anything',
		);
	}
	return Object.freeze({ ...definition });
}

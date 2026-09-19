import type { BucketConfig, BucketDefinition, MetadataSchema } from './types';

/**
 * A bucket, described once.
 *
 * It is the GridFS counterpart of `defineCollection`: the name, the shape of
 * the metadata, and the chunk size, in one object that both the reads and the
 * writes are typed from.
 *
 * ```ts
 * export const avatars = defineBucket({
 * 	name: 'avatars',
 * 	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
 * });
 * ```
 */
export function defineBucket<M extends MetadataSchema | undefined = undefined>(
	config: BucketConfig<M>,
): BucketDefinition<M> {
	const { name } = config;
	if (!name || name.includes('.') || name.includes('$')) {
		throw new TypeError(
			`defineBucket: "${name}" is not a bucket name. GridFS builds ` +
				'"<name>.files" and "<name>.chunks" from it, so it may not be ' +
				'empty and may not contain "." or "$".',
		);
	}
	const { chunkSize } = config;
	if (
		chunkSize !== undefined &&
		(!Number.isInteger(chunkSize) || chunkSize < 1)
	) {
		throw new TypeError(
			`defineBucket: "${name}" has a chunkSize of ${String(chunkSize)}; it ` +
				'must be a whole number of bytes, at least 1.',
		);
	}
	// The type and the digest live in the metadata, because GridFS keeps no
	// field for either: measured on mongodb 7.6.0, `contentType` passed to
	// `openUploadStream` is dropped without a word. So a schema may not claim
	// those two names, or a read would give back this package's own bookkeeping
	// as if the caller had written it.
	for (const reserved of ['contentType', 'sha256']) {
		if (config.metadata?.shape && reserved in config.metadata.shape) {
			throw new TypeError(
				`defineBucket: "${name}" declares a metadata field "${reserved}", ` +
					"which is where this package keeps the file's own content type " +
					'and digest. Name it something else.',
			);
		}
	}
	return Object.freeze({
		name,
		metadata: config.metadata as M,
		chunkSize,
		collections: Object.freeze({
			files: `${name}.files`,
			chunks: `${name}.chunks`,
		}),
	});
}

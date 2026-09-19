import { z } from 'zod';
import { objectId } from '../src/definition/fields';
import { defineBucket } from '../src/gridfs/define-bucket';

/** Metadata the bucket knows about, ids and dates included. */
export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({
		userId: objectId(),
		width: z.int().min(1).optional(),
		takenAt: z.date().nullable().default(null),
	}),
});

/** No metadata schema at all: what the driver would let through. */
export const uploads = defineBucket({ name: 'uploads' });

/** Small chunks, so a range spans several of them. */
export const clips = defineBucket({ name: 'clips', chunkSize: 1024 });

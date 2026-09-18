import { defineCollection, id, objectId } from '@nxgt/mongo';
import { z } from 'zod';

/**
 * An article. It is soft-deleted, so `delete` writes `deletedAt` and every
 * read leaves it out on its own; `createdBy` is stamped from the kit's
 * actor, which is why no handler passes an author.
 */
export const articles = defineCollection({
	name: 'articles',
	schema: z.object({
		_id: id(),
		title: z.string().min(1),
		body: z.string().min(1),
	}),
	timestamps: true,
	softDelete: true,
	actors: { type: objectId() },
	indexes: [{ key: { createdAt: -1 }, name: 'articles_recent' }],
});

import { defineCollection, id, objectId } from '@nxgt/mongo';
import { z } from 'zod';

/**
 * A user. `articles` is kept up to date by the transaction that writes one,
 * so a list never has to count.
 */
export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().optional(),
		articles: z.number().int().default(0),
	}),
	timestamps: true,
	actors: { type: objectId() },
	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
});

import { z } from 'zod';
import { defineCollection } from '../src/definition/define-collection';
import {
	actors,
	id,
	objectId,
	optimisticLock,
	softDelete,
	timestamps,
} from '../src/definition/fields';

/** Everything the collection knows about: stamps, soft delete and a version. */
export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().nullable().default(null),
		age: z.int().min(0).optional(),
		teamId: objectId().nullable().default(null),
		...timestamps(),
		...softDelete(),
		...optimisticLock(),
		...actors(),
	}),
	indexes: [
		{ key: { email: 1 }, unique: true, name: 'users_email_unique' },
		{ key: { createdAt: -1 }, name: 'users_createdAt' },
	],
});

/** No stamps at all: a real delete, no version, no `updatedAt` to touch. */
export const posts = defineCollection({
	name: 'posts',
	schema: z.object({
		_id: id(),
		title: z.string(),
		rank: z.int(),
		tags: z.array(z.string()).default([]),
	}),
	indexes: [{ key: { rank: 1, title: 1 }, name: 'posts_rank_title' }],
});

/** No validator: `sync` writes none, and the server checks nothing. */
export const logs = defineCollection({
	name: 'logs',
	schema: z.object({ _id: id(), message: z.string() }),
	validation: { level: 'off' },
});

export type User = z.output<typeof users.schema>;
export type Post = z.output<typeof posts.schema>;

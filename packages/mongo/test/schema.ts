import { z } from 'zod';
import { defineCollection } from '../src/definition/define-collection';
import { id, objectId } from '../src/definition/fields';

/** Everything the collection knows about: stamps, soft delete and a version. */
export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().nullable().default(null),
		age: z.int().min(0).optional(),
		teamId: objectId().nullable().default(null),
	}),
	timestamps: true,
	softDelete: true,
	optimisticLock: true,
	actors: true,
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

/** The same stamps as `users`, under names of this collection's choosing. */
export const tickets = defineCollection({
	name: 'tickets',
	schema: z.object({ _id: id(), subject: z.string() }),
	timestamps: true,
	softDelete: { deletedAt: 'removedAt' },
	optimisticLock: { version: 'revision' },
	actors: { createdBy: 'openedBy', deletedBy: false },
});

export type User = z.output<typeof users.schema>;
export type Post = z.output<typeof posts.schema>;
export type Ticket = z.output<typeof tickets.schema>;

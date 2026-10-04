// Every part of the kit an app exports, behind exported values whose types
// are inferred: a declaration build must be able to name each one through
// `@nxgt/mongo` and the peers alone (TS2883 otherwise).
import {
	createKit,
	defineCollection,
	defineConfig,
	id,
	objectId,
} from '@nxgt/mongo';
import { defineBucket } from '@nxgt/mongo/gridfs';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';

const uri = 'mongodb://127.0.0.1:1/unused';

export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		loginCount: z.int().default(0),
	}),
	timestamps: true,
	softDelete: true,
	optimisticLock: true,
	actors: true,
});

export const posts = defineCollection({
	name: 'posts',
	schema: z.object({ _id: id(), title: z.string(), authorId: objectId() }),
	timestamps: true,
	actors: true,
});

export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
});

export const config = defineConfig({
	uri,
	collections: { users, posts },
	buckets: { avatars },
});

export const kit = await createKit(config);

export const several = await createKit(
	defineConfig({
		databases: {
			main: { uri, collections: { users } },
			analytics: { uri, collections: { posts } },
		},
	}),
);

export function asUser(userId: ObjectId) {
	return kit.as(userId);
}

export function inTransaction() {
	return kit.transaction(async (tx) => tx.db.users.create({ email: 'a@b.c' }));
}

export function firstUser() {
	return kit.db.users.findOne({});
}

export function avatar() {
	return kit.db.avatars;
}

export function synced() {
	return kit.sync();
}

export function main() {
	return several.databases.main;
}

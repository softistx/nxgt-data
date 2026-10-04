// Every part of the Mongo an app exports, behind exported values whose types
// are inferred: a declaration build must be able to name each one through
// `@nxgt/mongo` and the peers alone (TS2883 otherwise).
import {
	defineCollection,
	defineMongo,
	id,
	objectId,
	openMongo,
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

export const config = defineMongo({
	uri,
	collections: { users, posts },
	buckets: { avatars },
});

export const mongo = await openMongo(config);

export const several = await openMongo(
	defineMongo({
		databases: {
			main: { uri, collections: { users } },
			analytics: { uri, collections: { posts } },
		},
	}),
);

export function asUser(userId: ObjectId) {
	return mongo.as(userId);
}

export function inTransaction() {
	return mongo.transaction(async (tx) =>
		tx.db.users.create({ email: 'a@b.c' }),
	);
}

export function firstUser() {
	return mongo.db.users.findOne({});
}

export function avatar() {
	return mongo.db.avatars;
}

export function synced() {
	return mongo.sync();
}

export function main() {
	return several.databases.main;
}

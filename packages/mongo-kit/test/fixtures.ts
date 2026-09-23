import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { closeMongo, defineCollection, id, objectId } from '@nxgt/mongo';
import { defineBucket } from '@nxgt/mongo/gridfs';
import { z } from 'zod';
import { startMongo, type TestServer } from './server';

/** Stamped and with an actor, so `as` has something to write. */
export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.string(),
		name: z.string().optional(),
	}),
	timestamps: true,
	actors: { type: objectId() },
	// What `autoSync` creates beside the collection, and a spec can measure.
	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
});

/** Soft-deleted, so a spec can tell a kit's options from a collection's. */
export const posts = defineCollection({
	name: 'posts',
	schema: z.object({
		_id: id(),
		title: z.string(),
		votes: z.number().default(0),
	}),
	timestamps: true,
	softDelete: true,
	actors: { type: objectId() },
});

/** A second database's collection, under a name neither of the others has. */
export const events = defineCollection({
	name: 'events',
	schema: z.object({ _id: id(), kind: z.string() }),
	timestamps: true,
});

/** What an application passes as `import * as collections`. */
export const collections = { users, posts };

/** A bucket whose metadata is typed, an id included, so coercion shows. */
export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
});

/** A bucket with no metadata schema. */
export const uploads = defineBucket({ name: 'uploads' });

/**
 * What an application passes as `import * as buckets`, with an export that
 * is no bucket, which the kit leaves out.
 */
export const buckets = { avatars, uploads, MAX_SIZE: 1024 };

/**
 * One mongod per spec file, emptied before every test, and the kits a test
 * opened closed after it — a kit left open holds a client, and the server
 * would not stop.
 */
export function useMongo(name: string) {
	const server = {} as TestServer;
	const kits: { close(): Promise<void> }[] = [];
	beforeAll(async () => {
		Object.assign(server, await startMongo(name));
	});
	beforeEach(async () => {
		await server.reset();
	});
	afterAll(async () => {
		for (const kit of kits) await kit.close().catch(() => undefined);
		await closeMongo();
		await server.stop();
	});
	return {
		server,
		/** Closes this kit after the file, whatever the test does. */
		track<K extends { close(): Promise<void> }>(kit: K): K {
			kits.push(kit);
			return kit;
		},
	};
}

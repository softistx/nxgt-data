import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { closeMongo, defineMongo, openMongo } from '@nxgt/mongo';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import * as collections from '../src/collections';
import type { AppMongo } from '../src/db';

/**
 * The same mongod the packages' specs use — a single-node replica set,
 * because writing an article runs in a transaction. Keep the version equal
 * to the copies under `packages`, in each test server: CI caches the binary
 * on the hash of them all.
 */
export const MONGOD_VERSION = '8.2.6';

/** Where the binary is cached: the repository's git-ignored `.cache`. */
const MONGOD_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'mongodb',
);

/**
 * One mongod per spec file, a Mongo over it, and an empty database before
 * every test. The Mongo is the caller's to derive from — `mongo.as(someone)` is
 * what a request does.
 */
export function useMongo(database: string) {
	const state = {} as { mongo: AppMongo };
	let replSet: MongoMemoryReplSet;

	beforeAll(async () => {
		replSet = await MongoMemoryReplSet.create({
			replSet: { count: 1, storageEngine: 'wiredTiger' },
			binary: { version: MONGOD_VERSION, downloadDir: MONGOD_CACHE },
			instanceOpts: [{ launchTimeout: 60_000 }],
		});
		state.mongo = await openMongo(
			defineMongo({
				uri: replSet.getUri(database),
				collections,
				options: { maxPageSize: 50 },
			}),
		);
	});

	beforeEach(async () => {
		await state.mongo.db.dropDatabase();
		// What `bun run sync` does on a deployment. `autoSync` would not do
		// here: it syncs once per collection and per process, and the drop
		// above takes the indexes with it.
		await state.mongo.sync();
	});

	afterAll(async () => {
		await state.mongo.close();
		await closeMongo();
		await replSet.stop({ doCleanup: true });
	});

	return state;
}

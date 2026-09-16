import { join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

/**
 * The mongod the specs run against. Pinned, because the memory server's own
 * default moves between its minor releases, and because the build it picks
 * decides which OpenSSL it needs: 6.0 and up resolve to the ubuntu 22.04
 * build, which links OpenSSL 3, the one a current distribution ships. Older
 * ones want `libcrypto.so.1.1` and do not start.
 */
export const MONGOD_VERSION = '8.2.6';

/**
 * Where the binary is cached: the repository's git-ignored `.cache`, next to
 * Meilisearch's, so CI caches one directory and a spec run downloads nothing.
 */
export const MONGOD_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'mongodb',
);

export interface TestServer {
	uri: string;
	client: MongoClient;
	db: Db;
	/** Drops the database, so each test starts from an empty one. */
	reset(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * A real MongoDB, one per spec file: a **single-node replica set**, which is
 * what transactions need — a standalone mongod refuses to start one. Starting
 * it takes about 300 ms once the binary is cached, and about 25 seconds the
 * first time, which is the download.
 */
export async function startMongo(dbName = 'nxgt-mongo'): Promise<TestServer> {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
		binary: { version: MONGOD_VERSION, downloadDir: MONGOD_CACHE },
		// 10 seconds is the default, and a cold CI runner takes longer.
		instanceOpts: [{ launchTimeout: 60_000 }],
	});

	const uri = replSet.getUri(dbName);
	const client = await MongoClient.connect(uri);
	const db = client.db(dbName);

	return {
		uri,
		client,
		db,
		reset: async () => {
			await db.dropDatabase();
		},
		stop: async () => {
			await client.close();
			await replSet.stop({ doCleanup: true });
		},
	};
}

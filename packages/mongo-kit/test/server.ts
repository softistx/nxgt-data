import { join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

/**
 * A copy of `@nxgt/mongo`'s `test/server.ts`: this package reaches no sibling's
 * tests. Keep `MONGOD_VERSION` the same in every copy; CI keys its cache on
 * all of them.
 *
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
	/** Makes the next `times` of these commands fail, as the server would. */
	failNext(
		commands: string[],
		failure: Record<string, unknown>,
		times?: number,
	): Promise<void>;
	/** Turns `failNext` off, whatever it has left to fail. */
	clearFailures(): Promise<void>;
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
export async function startMongo(
	dbName = 'nxgt-mongo-kit',
): Promise<TestServer> {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
		binary: { version: MONGOD_VERSION, downloadDir: MONGOD_CACHE },
		instanceOpts: [
			{
				// 10 seconds is the default, and a cold CI runner takes longer.
				launchTimeout: 60_000,
				// `configureFailPoint`, which is how a spec makes the server fail a
				// change stream's `getMore` on demand. Never on a real deployment.
				args: ['--setParameter', 'enableTestCommands=1'],
			},
		],
	});

	const uri = replSet.getUri(dbName);
	const client = await MongoClient.connect(uri);
	const db = client.db(dbName);

	return {
		uri,
		client,
		db,
		failNext: async (commands, failure, times = 1) => {
			await client.db('admin').command({
				configureFailPoint: 'failCommand',
				mode: { times },
				data: { failCommands: commands, ...failure },
			});
		},
		// `{ times: 0 }` would still fail one more command — measured; `off` does not.
		clearFailures: async () => {
			await client
				.db('admin')
				.command({ configureFailPoint: 'failCommand', mode: 'off' });
		},
		reset: async () => {
			await db.dropDatabase();
		},
		stop: async () => {
			await client.close();
			await replSet.stop({ doCleanup: true });
		},
	};
}

import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

/**
 * A single-node replica set for the specs — a change stream needs one. The
 * version and the cache are `@nxgt/mongo`'s (`packages/mongo/test/server.ts`);
 * keep them the same, CI keys its cache on both files.
 */
const MONGOD_VERSION = '8.2.6';
const MONGOD_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'mongodb',
);

export async function startMongo() {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
		binary: { version: MONGOD_VERSION, downloadDir: MONGOD_CACHE },
		// `enableTestCommands`: how a spec makes the server fail a command.
		instanceOpts: [
			{
				launchTimeout: 60_000,
				args: ['--setParameter', 'enableTestCommands=1'],
			},
		],
	});
	const uri = replSet.getUri();
	const client = await MongoClient.connect(uri);
	return {
		uri,
		client,
		/** The next `command` fails with `code`, as the server would. */
		failNext: async (command: string, code: number) => {
			await client.db('admin').command({
				configureFailPoint: 'failCommand',
				mode: { times: 1 },
				data: { failCommands: [command], errorCode: code },
			});
		},
		stop: async () => {
			await client.close();
			await replSet.stop({ doCleanup: true });
		},
	};
}

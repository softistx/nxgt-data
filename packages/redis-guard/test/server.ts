import { join } from 'node:path';
import { RedisClient } from 'bun';
import RedisMemoryServer from 'redis-memory-server';
import RedisBinary from 'redis-memory-server/lib/util/RedisBinary';

/**
 * A copy of `@nxgt/redis`'s `test/server.ts`, the third after
 * `@nxgt/redis-kit`'s: this package reaches no sibling's tests, so it carries
 * its own. Keep `REDIS_VERSION` the same in every copy — CI keys the Redis
 * build cache on the hash of all of them.
 */

/**
 * The Redis the specs run against. Pinned, like the mongod and the
 * Meilisearch the other packages use, so a release of the server does not
 * quietly change what is measured here.
 *
 * `redis-memory-server` does not download a binary: neither redis/redis nor
 * valkey publishes one, so it **compiles** Redis from source on the first
 * start. **This is the one place that measurement is written down**, and
 * `scripts/redis.ts`, `AGENTS.md` and the CI cache step all point here
 * rather than repeat it:
 *
 * - building 7.4.1 the first time: **about two minutes**;
 * - starting it once built: **23 ms**;
 * - what that leaves on disk: **18 MB**, in `REDIS_CACHE`.
 */
export const REDIS_VERSION = '7.4.1';

/**
 * Where that build is cached: the repository's git-ignored `.cache`, beside
 * mongod's and Meilisearch's, so CI caches one directory and a spec run
 * compiles nothing.
 */
export const REDIS_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'redis',
);

/**
 * The `redis-server` these specs run, built if it is not cached yet, or the
 * one `$REDIS_BIN` names. This is what `scripts/redis.ts` calls, so that the
 * build happens before any test's timeout can run out.
 */
export async function redisBinary(): Promise<string> {
	const given = process.env.REDIS_BIN;
	if (given) return given;
	return await RedisBinary.getPath({
		version: REDIS_VERSION,
		downloadDir: REDIS_CACHE,
	});
}

export interface TestServer {
	uri: string;
	/** A client of this server, the specs' own. */
	client: RedisClient;
	/** Empties the server, so each test starts from nothing. */
	reset(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * A real Redis, one per spec file. In a cold checkout the first call builds
 * it, which is why `test/fixtures.ts` gives its `beforeAll` 120 s — the
 * package's own `test` script runs `scripts/redis.ts` first, so that build
 * normally happens before any test starts.
 */
export async function startRedis(): Promise<TestServer> {
	const server = await RedisMemoryServer.create({
		binary: process.env.REDIS_BIN
			? { systemBinary: process.env.REDIS_BIN }
			: { version: REDIS_VERSION, downloadDir: REDIS_CACHE },
	});
	const host = await server.getHost();
	const port = await server.getPort();
	const uri = `redis://${host}:${port}`;

	const client = new RedisClient(uri);
	await client.connect();

	return {
		uri,
		client,
		reset: async () => {
			await client.send('FLUSHALL', []);
		},
		stop: async () => {
			client.close();
			await server.stop();
		},
	};
}

import { join } from 'node:path';
import { RedisClient } from 'bun';
import {
	buildTestRedis,
	startTestRedis,
	TEST_REDIS_VERSION,
} from '../src/testing';

/**
 * The Redis the specs run against: `@nxgt/redis/testing`'s
 * `startTestRedis`, which a consumer's suites run too, at the version it
 * pins (`TEST_REDIS_VERSION`, in `src/testing/test-redis.ts` — raise it
 * there). Pinned, like the mongod and the Meilisearch the other packages
 * use, so a release of the server does not quietly change what is measured
 * here.
 *
 * `redis-memory-server` does not download a binary: neither redis/redis nor
 * valkey publishes one, so it **compiles** Redis from source on the first
 * start. **This is the one place that measurement is written down**, and
 * `scripts/redis.ts`, `AGENTS.md` and the CI cache step all point here
 * rather than repeat it (`buildTestRedis`'s comment quotes it for consumers):
 *
 * - building 7.4.1 the first time: **about two minutes**;
 * - starting it once built: **23 ms**;
 * - what that leaves on disk: **18 MB**, in `REDIS_CACHE`.
 */
export const REDIS_VERSION = TEST_REDIS_VERSION;

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
	return await buildTestRedis({ downloadDir: REDIS_CACHE });
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
	const server = await startTestRedis({ downloadDir: REDIS_CACHE });
	const client = new RedisClient(server.uri);
	await client.connect();

	return {
		uri: server.uri,
		client,
		reset: server.reset,
		stop: async () => {
			client.close();
			await server.stop();
		},
	};
}

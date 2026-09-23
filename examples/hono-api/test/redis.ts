import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { RedisClient } from 'bun';
import RedisMemoryServer from 'redis-memory-server';

/**
 * A copy of `@nxgt/redis`'s `test/server.ts`, the fourth after
 * `@nxgt/redis-kit`'s and `@nxgt/redis-guard`'s: an example reaches no
 * package's tests, so it carries its own. Keep `REDIS_VERSION` the same in
 * every copy — CI keys the Redis build cache on the hash of all of them.
 *
 * It starts the server and nothing more: `redisBinary`, which builds it, is
 * what `scripts/redis.ts` runs, and this example's `test` script runs that
 * first, so the build never lands inside a spec's timeout. What the build
 * costs is written down once, in `packages/redis/test/server.ts`.
 */
export const REDIS_VERSION = '7.4.1';

/** Where that build is cached: the repository's git-ignored `.cache`. */
export const REDIS_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'redis',
);

export interface TestServer {
	uri: string;
	/** A client of this server: the one the app under test is given. */
	client: RedisClient;
	stop(): Promise<void>;
}

/** A real Redis, on a free port. `$REDIS_BIN` names another `redis-server`. */
export async function startRedis(): Promise<TestServer> {
	const server = await RedisMemoryServer.create({
		binary: process.env.REDIS_BIN
			? { systemBinary: process.env.REDIS_BIN }
			: { version: REDIS_VERSION, downloadDir: REDIS_CACHE },
	});
	const uri = `redis://${await server.getHost()}:${await server.getPort()}`;

	const client = new RedisClient(uri);
	await client.connect();

	return {
		uri,
		client,
		stop: async () => {
			client.close();
			await server.stop();
		},
	};
}

/**
 * One Redis per spec file, emptied before every test: a bucket or an
 * idempotency key one test left would change what the next one sees — a
 * limit already spent, a result replayed instead of written.
 */
export function useRedis() {
	const state = {} as { redis: TestServer };

	beforeAll(async () => {
		state.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await state.redis.client.send('FLUSHDB', []);
	});

	afterAll(async () => {
		await state.redis?.stop();
	});

	return state;
}

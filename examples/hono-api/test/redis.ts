import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import RedisMemoryServer from 'redis-memory-server';

/**
 * A real Redis for the specs, started from the `redis-server` that
 * `$REDIS_BIN` names — and nothing else. This file pins no version and
 * builds nothing: the example's `test` script runs `scripts/redis.ts`, which
 * builds the repository's one pinned Redis (`REDIS_VERSION`, in
 * `packages/redis/test/server.ts`) into `.cache/redis` and prints its path,
 * and hands that path over as `$REDIS_BIN`. So there is no version here to
 * keep in step with the packages', and no build inside a spec's timeout.
 * The script calls `scripts/redis.ts` twice on purpose: the first call
 * builds, and stops the chain if the build fails; only the second runs
 * inside `$(...)`. On a cold cache redis-memory-server logs its download
 * progress to a stdout that is not a TTY, which a single `$(...)` call would
 * capture into `$REDIS_BIN`.
 */
function redisBin(): string {
	const bin = process.env.REDIS_BIN;
	if (!bin) {
		throw new Error(
			'REDIS_BIN is not set: run the specs with `bun run test`, which builds Redis with scripts/redis.ts and passes its path',
		);
	}
	return bin;
}

export interface TestServer {
	uri: string;
	/** A client of this server: the one the app under test is given. */
	client: RedisClient;
	stop(): Promise<void>;
}

/** A real Redis, on a free port. */
export async function startRedis(): Promise<TestServer> {
	const server = await RedisMemoryServer.create({
		binary: { systemBinary: redisBin() },
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
	});

	beforeEach(async () => {
		await state.redis.client.send('FLUSHDB', []);
	});

	afterAll(async () => {
		await state.redis?.stop();
	});

	return state;
}

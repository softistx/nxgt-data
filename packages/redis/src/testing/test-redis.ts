import { RedisClient } from 'bun';
import { RedisBinary, RedisMemoryServer } from 'redis-memory-server';

/**
 * The Redis version `startTestRedis` builds when no binary is given: the one
 * this package's own specs run against, pinned so that a release of Redis
 * does not quietly change what a suite measures.
 */
export const TEST_REDIS_VERSION = '7.4.1';

/** Where the Redis a suite runs comes from. */
export interface TestRedisOptions {
	/**
	 * A `redis-server` to run instead of building one: a system binary, or a
	 * build made earlier. Defaults to `$REDIS_BIN`; with neither, Redis is
	 * built from source on the first call — see `buildTestRedis`.
	 */
	binary?: string | undefined;
	/** The version to build when no binary is given. Defaults to `TEST_REDIS_VERSION`. */
	version?: string | undefined;
	/**
	 * Where that build is kept. Defaults to `redis-memory-server`'s own cache,
	 * `node_modules/.cache/redis-memory-server`.
	 */
	downloadDir?: string | undefined;
}

/** A Redis of its own, for one suite. */
export interface TestRedis {
	/** `redis://<host>:<port>`, a free port on the loopback. */
	readonly uri: string;
	/** Empties the server (`FLUSHALL`), so each test starts from nothing. */
	reset(): Promise<void>;
	/** Stops the server. A second call does nothing. */
	stop(): Promise<void>;
}

/** `$REDIS_BIN`, when it names something. */
function givenBinary(options: TestRedisOptions): string | undefined {
	return options.binary || process.env['REDIS_BIN'] || undefined;
}

/** `redis-memory-server`'s binary options, with only the keys that have a value. */
function buildOptions(options: TestRedisOptions) {
	return {
		version: options.version ?? TEST_REDIS_VERSION,
		...(options.downloadDir ? { downloadDir: options.downloadDir } : {}),
	};
}

/**
 * The `redis-server` `startTestRedis` would run: the one `binary` or
 * `$REDIS_BIN` names, as given, or the pinned version, **compiled from
 * source** the first time — neither redis/redis nor valkey publishes a
 * prebuilt binary — and cached after that.
 *
 * Measured for this package's own specs: about two minutes to build 7.4.1, 23 ms to
 * start it once built, 18 MB on disk. Call this from a script that runs
 * before the suite (`bun run test/redis.ts && bun test`), so that the build
 * never runs inside a test's timeout.
 */
export async function buildTestRedis(
	options: TestRedisOptions = {},
): Promise<string> {
	const given = givenBinary(options);
	if (given) return given;
	return await RedisBinary.getPath(buildOptions(options));
}

/**
 * Starts a real Redis on a free port, for one suite: `$REDIS_BIN` or
 * `binary` when one is named, or else the pinned version, built on the first
 * call (see `buildTestRedis`, and give the hook that calls this a timeout
 * long enough for a cold build).
 *
 * ```ts
 * import { startTestRedis, type TestRedis } from '@nxgt/redis/testing';
 *
 * let redis: TestRedis;
 * beforeAll(async () => { redis = await startTestRedis(); }, 180_000);
 * beforeEach(() => redis.reset());
 * afterAll(() => redis.stop());
 * ```
 *
 * It needs `redis-memory-server`, an optional peer of `@nxgt/redis`:
 * install it as a devDependency where the suite runs.
 */
export async function startTestRedis(
	options: TestRedisOptions = {},
): Promise<TestRedis> {
	const given = givenBinary(options);
	const server = await RedisMemoryServer.create({
		binary: given ? { systemBinary: given } : buildOptions(options),
	});
	const uri = `redis://${await server.getHost()}:${await server.getPort()}`;
	const client = new RedisClient(uri);
	try {
		await client.connect();
	} catch (error) {
		await server.stop();
		throw error;
	}

	let stopped: Promise<void> | undefined;
	return {
		uri,
		reset: async () => {
			await client.send('FLUSHALL', []);
		},
		stop: () => {
			stopped ??= (async () => {
				client.close();
				await server.stop();
			})();
			return stopped;
		},
	};
}

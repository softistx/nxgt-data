import { afterEach, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { REDIS_CACHE, redisBinary } from '../../test/server';
import {
	buildTestRedis,
	startTestRedis,
	TEST_REDIS_VERSION,
	type TestRedis,
} from './';

// `@nxgt/redis/testing`, as a consumer's suite uses it. The binary is the one
// `scripts/redis.ts` built before the specs: through `$REDIS_BIN`, or through
// `downloadDir`, where the pinned version is already cached.

const started: TestRedis[] = [];
const clients: RedisClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const redis of started.splice(0)) await redis.stop();
});

/** Runs `fn` with `$REDIS_BIN` set to `value`, or unset, and puts it back. */
async function withBin<T>(
	value: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const before = process.env['REDIS_BIN'];
	if (value === undefined) delete process.env['REDIS_BIN'];
	else process.env['REDIS_BIN'] = value;
	try {
		return await fn();
	} finally {
		if (before === undefined) delete process.env['REDIS_BIN'];
		else process.env['REDIS_BIN'] = before;
	}
}

async function clientOf(redis: TestRedis): Promise<RedisClient> {
	const client = new RedisClient(redis.uri);
	await client.connect();
	clients.push(client);
	return client;
}

describe('startTestRedis', () => {
	test('runs the binary $REDIS_BIN names, and reset empties it', async () => {
		const binary = await redisBinary();
		const redis = await withBin(binary, () => startTestRedis());
		started.push(redis);
		expect(redis.uri).toMatch(/^redis:\/\/[^/]+:\d+$/);

		const client = await clientOf(redis);
		await client.set('a', '1');
		await client.send('SELECT', ['1']);
		await client.set('b', '2');
		await redis.reset();
		expect(await client.exists('b')).toBe(false);
		await client.send('SELECT', ['0']);
		expect(await client.exists('a')).toBe(false);
	});

	test('runs the pinned version from downloadDir, with no $REDIS_BIN', async () => {
		const redis = await withBin(undefined, () =>
			startTestRedis({ downloadDir: REDIS_CACHE }),
		);
		started.push(redis);
		const client = await clientOf(redis);
		const info = String(await client.send('INFO', ['server']));
		expect(info).toContain(`redis_version:${TEST_REDIS_VERSION}`);
	});

	test('binary wins over $REDIS_BIN', async () => {
		const binary = await redisBinary();
		const redis = await withBin('/nowhere/redis-server', () =>
			startTestRedis({ binary }),
		);
		started.push(redis);
		expect(String(await (await clientOf(redis)).ping())).toBe('PONG');
	});

	test('two at once are two servers', async () => {
		const binary = await redisBinary();
		const [a, b] = await Promise.all([
			startTestRedis({ binary }),
			startTestRedis({ binary }),
		]);
		started.push(a, b);
		expect(a.uri).not.toBe(b.uri);
		await (await clientOf(a)).set('k', 'a');
		expect(await (await clientOf(b)).exists('k')).toBe(false);
	});

	test('stop stops the server, and a second stop does nothing', async () => {
		const redis = await startTestRedis({ binary: await redisBinary() });
		await redis.stop();
		await redis.stop();
		const client = new RedisClient(redis.uri, {
			autoReconnect: false,
			connectionTimeout: 1_000,
		});
		const refused = await client.connect().then(
			() => false,
			() => true,
		);
		client.close();
		expect(refused).toBe(true);
	});
});

describe('buildTestRedis', () => {
	test('gives $REDIS_BIN as it is, and builds nothing', async () => {
		const path = await withBin('/opt/redis/redis-server', () =>
			buildTestRedis(),
		);
		expect(path).toBe('/opt/redis/redis-server');
	});

	test('gives binary over $REDIS_BIN', async () => {
		const path = await withBin('/opt/redis/redis-server', () =>
			buildTestRedis({ binary: '/usr/bin/redis-server' }),
		);
		expect(path).toBe('/usr/bin/redis-server');
	});

	test('finds the pinned version in downloadDir', async () => {
		const path = await withBin(undefined, () =>
			buildTestRedis({ downloadDir: REDIS_CACHE }),
		);
		expect(path).toBe(`${REDIS_CACHE}/${TEST_REDIS_VERSION}/redis-server`);
	});

	test('pins a version', () => {
		expect(TEST_REDIS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

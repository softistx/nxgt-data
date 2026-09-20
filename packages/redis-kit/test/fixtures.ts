import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { closeRedis } from '@nxgt/redis';
import type { RedisKit } from '../src/kit/types';
import { startRedis, type TestServer } from './server';

export * as caches from './caches';
export * as channels from './channels';

/**
 * One Redis per spec file, emptied before each test, and every kit a test
 * opened closed before the server stops.
 *
 * `closeRedis()` runs last for the same reason as in `@nxgt/redis`'s own
 * fixtures: `connectRedis` shares a client per URI, so a connection a test
 * left open would outlive the server it points at. The kits are tracked
 * because a subscription holds a connection duplicated from the client, and
 * one nobody closed would keep the server from stopping.
 */
export function useRedis() {
	const servers = {} as { redis: TestServer };
	const kits: RedisKit<never>[] = [];

	beforeAll(async () => {
		servers.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await servers.redis.reset();
	});

	afterAll(async () => {
		for (const kit of kits.splice(0)) await kit.close().catch(() => undefined);
		await closeRedis();
		await servers.redis?.stop();
	});

	/** A kit this file will close for you when it ends. */
	function track<K>(kit: K): K {
		kits.push(kit as unknown as RedisKit<never>);
		return kit;
	}

	return { servers, track };
}

/** Polls `read` until it gives what `expected` is, or fails after a while. */
export async function eventually<T>(
	read: () => Promise<T> | T,
	expected: T,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const value = await read();
		if (Bun.deepEquals(value, expected)) return;
		if (Date.now() > deadline) {
			throw new Error(
				`still ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`,
			);
		}
		await Bun.sleep(20);
	}
}

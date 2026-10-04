import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { z } from 'zod';
import { defineCache } from '../src/cache/define-cache';
import { defineChannel } from '../src/channel/define-channel';
import { closeRedis } from '../src/connection/connect';
import type { Redis } from '../src/wiring/types';
import { startRedis, type TestServer } from './server';

export const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),
});

export type User = z.output<typeof userSchema>;

/** Keyed by a plain id. */
export const userCache = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 60,
	schema: userSchema,
});

/** Keyed by more than one thing, which is why `key` takes an object. */
export const seatCache = defineCache({
	name: 'seat',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	ttl: 60,
	schema: z.object({ taken: z.number() }),
});

export const userCreated = defineChannel({
	name: 'user.created',
	schema: userSchema,
});

/**
 * One Redis per spec file, emptied before each test, and every Redis a test
 * opened closed before the server stops.
 *
 * `closeRedis()` runs last: `connectRedis` shares a client per URI, so a
 * connection a test left open would keep one alive past the server. The Redis objects
 * are tracked because a subscription holds a connection duplicated from the
 * client, and one nobody closed would keep the server from stopping.
 */
export function useRedis() {
	const servers = {} as { redis: TestServer; track: <K>(redis: K) => K };
	const opened: Redis<never>[] = [];

	beforeAll(async () => {
		servers.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await servers.redis.reset();
	});

	afterAll(async () => {
		for (const redis of opened.splice(0))
			await redis.close().catch(() => undefined);
		await closeRedis();
		await servers.redis?.stop();
	});

	/** A Redis this file will close for you when it ends. */
	servers.track = <K>(redis: K): K => {
		opened.push(redis as unknown as Redis<never>);
		return redis;
	};

	return servers;
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

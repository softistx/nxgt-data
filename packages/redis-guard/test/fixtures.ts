import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { defineRateLimit } from '../src/rate-limit/define-rate-limit';
import { startRedis, type TestServer } from './server';

/** Five a minute per address: the README's example. */
export const loginLimit = defineRateLimit({
	name: 'login',
	key: (params: { ip: string }) => params.ip,
	limit: 5,
	per: 60_000,
});

/**
 * Keyed by more than one thing, with a burst above its rate: ten at once,
 * then one every six seconds.
 */
export const exportLimit = defineRateLimit({
	name: 'export',
	key: (params: { org: string; user: string }) =>
		`${params.org}/${params.user}`,
	limit: 10,
	per: 60_000,
	burst: 20,
});

/**
 * One Redis per spec file, emptied before each test. This package opens no
 * client of its own — every call takes the caller's — so the server's own
 * client is the only one to close.
 */
export function useRedis() {
	const servers = {} as { redis: TestServer };

	beforeAll(async () => {
		servers.redis = await startRedis();
	}, 120_000);

	beforeEach(async () => {
		await servers.redis.reset();
	});

	afterAll(async () => {
		await servers.redis?.stop();
	});

	return servers;
}

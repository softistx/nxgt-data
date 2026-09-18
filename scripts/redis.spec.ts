import { describe, expect, test } from 'bun:test';
import {
	REDIS_CACHE,
	REDIS_VERSION,
	redisBinary,
} from '../packages/redis/test/server';

/** Runs `fn` with `$REDIS_BIN` set, and puts the environment back. */
async function withBin(value: string, fn: () => Promise<void>): Promise<void> {
	const before = process.env.REDIS_BIN;
	process.env.REDIS_BIN = value;
	try {
		await fn();
	} finally {
		if (before === undefined) delete process.env.REDIS_BIN;
		else process.env.REDIS_BIN = before;
	}
}

describe('the Redis binary', () => {
	test('uses $REDIS_BIN when it names one, and builds nothing', async () => {
		// Nothing is checked about the path: a caller that names a binary is
		// telling this script not to build one, and that is the whole branch.
		await withBin('/opt/redis/redis-server', async () => {
			expect(await redisBinary()).toBe('/opt/redis/redis-server');
		});
	});

	test('caches under the repository’s .cache, beside the other servers', () => {
		expect(REDIS_CACHE.endsWith('/.cache/redis')).toBe(true);
	});

	test('pins the version, so a release of Redis does not move what is measured', () => {
		expect(REDIS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

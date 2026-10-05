import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { loginLimit, useRedis } from '../../test/fixtures';
import { bindRateLimit } from './bind-rate-limit';

const servers = useRedis();
const DAY = 24 * 60 * 60 * 1000;
const ada = { ip: '10.0.0.1' };

afterEach(() => {
	setSystemTime();
});

describe('the clock', () => {
	test('is the server’s: moving the host’s by a day either way changes nothing', async () => {
		const limit = bindRateLimit(servers.redis.client, loginLimit);
		const real = Date.now();

		const first = await limit.consume(ada);
		expect(first.remaining).toBe(4);

		// A day ahead: a limit timed by this host would find the bucket
		// refilled long ago, and answer 4 again.
		setSystemTime(new Date(real + DAY));
		const ahead = await limit.consume(ada);
		expect(ahead.remaining).toBe(3);
		expect(ahead.resetAfter).toBeLessThanOrEqual(24_000);

		// A day behind: one timed by this host would find the bucket a day
		// in the future, and deny.
		setSystemTime(new Date(real - DAY));
		const behind = await limit.consume(ada);
		expect(behind.allowed).toBe(true);
		expect(behind.remaining).toBe(2);
		expect(behind.resetAfter).toBeLessThanOrEqual(36_000);
		expect(behind.resetAfter).toBeGreaterThan(35_000);
	});
});

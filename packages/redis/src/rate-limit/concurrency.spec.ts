import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { loginLimit, useRedis } from '../../test/fixtures';
import { bindRateLimit } from './bind-rate-limit';

const servers = useRedis();

/**
 * Two clients are two connections, as two processes would have: Bun
 * pipelines one client's commands in order, so a race on one client alone
 * could pass with a check that is not atomic at all.
 */
const others: RedisClient[] = [];

beforeAll(async () => {
	for (let i = 0; i < 2; i += 1) {
		const client = new RedisClient(servers.redis.uri);
		await client.connect();
		others.push(client);
	}
});

afterAll(() => {
	for (const client of others.splice(0)) client.close();
});

describe('concurrent consumes', () => {
	test('50 at once from two clients allow exactly the burst', async () => {
		const [a, b] = others.map((client) => bindRateLimit(client, loginLimit));
		if (!a || !b) throw new Error('two clients expected');
		const who = { ip: '10.0.0.1' };
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? a : b).consume(who)),
		);
		expect(results.filter((r) => r.allowed)).toHaveLength(5);
		// Every allowed call saw a different count: none read a stale bucket.
		const remaining = results.filter((r) => r.allowed).map((r) => r.remaining);
		expect(remaining.sort()).toEqual([0, 1, 2, 3, 4]);
	});
});

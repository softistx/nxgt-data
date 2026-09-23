import { describe, expect, test } from 'bun:test';
import { exportLimit, loginLimit, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindRateLimit } from './bind-rate-limit';
import { defineRateLimit } from './define-rate-limit';

const servers = useRedis();
const login = () => bindRateLimit(servers.redis.client, loginLimit);
const ada = { ip: '10.0.0.1' };

/** Consumes `n` times in a row and gives back every result. */
async function consumeTimes(limit: ReturnType<typeof login>, n: number) {
	const results = [];
	for (let i = 0; i < n; i += 1) results.push(await limit.consume(ada));
	return results;
}

describe('consume', () => {
	test('allows the limit, then denies', async () => {
		const results = await consumeTimes(login(), 6);
		expect(results.map((r) => r.allowed)).toEqual([
			true,
			true,
			true,
			true,
			true,
			false,
		]);
		const denied = results[5];
		expect(denied?.retryAfter).toBeGreaterThan(0);
		// One request's worth of the rate: 60 s / 5.
		expect(denied?.retryAfter).toBeLessThanOrEqual(12_000);
		expect(results[0]?.retryAfter).toBe(0);
	});

	test('counts remaining down, and reports the burst as the limit', async () => {
		const results = await consumeTimes(login(), 6);
		expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
		expect(results.every((r) => r.limit === 5)).toBe(true);
	});

	test('a denial counts nothing', async () => {
		const limit = login();
		await consumeTimes(limit, 5);
		const before = await servers.redis.client.get('login:10.0.0.1');
		expect((await limit.consume(ada)).allowed).toBe(false);
		expect(await servers.redis.client.get('login:10.0.0.1')).toBe(before);
	});

	test('a burst above the rate allows the burst at once', async () => {
		const limit = bindRateLimit(servers.redis.client, exportLimit);
		const who = { org: 'acme', user: 'u1' };
		let allowed = 0;
		for (let i = 0; i < 25; i += 1) {
			if ((await limit.consume(who)).allowed) allowed += 1;
		}
		expect(allowed).toBe(20);
		const denied = await limit.consume(who);
		expect(denied.limit).toBe(20);
		// It refills at the rate, one every 6 s — not the burst's 3 s.
		expect(denied.retryAfter).toBeGreaterThan(3_000);
		expect(denied.retryAfter).toBeLessThanOrEqual(6_000);
	});

	test('a burst below the rate spreads the requests out', async () => {
		const spread = defineRateLimit({ ...loginLimit, name: 'spread', burst: 2 });
		const limit = bindRateLimit(servers.redis.client, spread);
		const results = [];
		for (let i = 0; i < 3; i += 1) results.push(await limit.consume(ada));
		expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
		expect(results[1]?.limit).toBe(2);
	});

	test('a cost counts for that many requests', async () => {
		const limit = login();
		const first = await limit.consume(ada, 3);
		expect(first.allowed).toBe(true);
		expect(first.remaining).toBe(2);
		// Three more do not fit in the two left, and take nothing from them.
		const second = await limit.consume(ada, 3);
		expect(second.allowed).toBe(false);
		expect(second.remaining).toBe(2);
		expect((await limit.consume(ada, 2)).remaining).toBe(0);
	});

	test('refuses a cost that is not a whole number from 1 to the burst', async () => {
		const limit = login();
		for (const cost of [0, 1.5, 6, -1, Number.NaN]) {
			const error = await rejection(limit.consume(ada, cost));
			expect(error).toBeInstanceOf(GuardError);
			expect(error).toMatchObject({
				code: 'COST',
				definition: 'login',
				message:
					'consume on "login": a cost must be a whole number from 1 to the burst of 5',
			});
		}
		// Nothing reached the server.
		expect(await servers.redis.client.exists('login:10.0.0.1')).toBe(false);
	});

	test('keeps every params’ bucket apart', async () => {
		const limit = login();
		await consumeTimes(limit, 5);
		expect((await limit.consume(ada)).allowed).toBe(false);
		const other = await limit.consume({ ip: '10.0.0.2' });
		expect(other.allowed).toBe(true);
		expect(other.remaining).toBe(4);
	});

	test('refills: waiting retryAfter is enough', async () => {
		const quick = defineRateLimit({
			name: 'quick',
			key: (id: string) => id,
			limit: 2,
			per: 200,
		});
		const limit = bindRateLimit(servers.redis.client, quick);
		await limit.consume('a');
		await limit.consume('a');
		const denied = await limit.consume('a');
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfter).toBeGreaterThan(0);
		expect(denied.retryAfter).toBeLessThanOrEqual(100);
		await Bun.sleep(denied.retryAfter);
		expect((await limit.consume('a')).allowed).toBe(true);
	});

	test('the key lives no longer than resetAfter, and a full bucket leaves none', async () => {
		const limit = login();
		const result = await limit.consume(ada, 2);
		const pttl = await servers.redis.client.pttl('login:10.0.0.1');
		expect(pttl).toBeGreaterThan(0);
		expect(pttl).toBeLessThanOrEqual(result.resetAfter);
		// Two of five a minute: the bucket is full again in 24 s.
		expect(result.resetAfter).toBeLessThanOrEqual(24_000);
		expect(result.resetAfter).toBeGreaterThan(23_000);
	});
});

describe('enforce', () => {
	test('gives the result while allowed, and throws RATE_LIMITED once spent', async () => {
		const limit = login();
		for (let i = 0; i < 5; i += 1) {
			expect((await limit.enforce(ada)).allowed).toBe(true);
		}
		const error = await rejection(limit.enforce(ada));
		expect(error).toBeInstanceOf(GuardError);
		expect(error).toMatchObject({
			code: 'RATE_LIMITED',
			definition: 'login',
			message:
				'enforce on "login": the limit of 5 per 60000ms is spent; retryAfter says when to try again',
		});
		const { retryAfter } = error as GuardError;
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(12_000);
	});

	test('carries neither the key nor the params', async () => {
		const limit = login();
		await consumeTimes(limit, 5);
		const error = await rejection(limit.enforce(ada));
		expect(JSON.stringify(error)).not.toContain('10.0.0.1');
		expect((error as Error).message).not.toContain('10.0.0.1');
	});

	test('refuses a bad cost under its own name', async () => {
		const error = await rejection(login().enforce(ada, 0));
		expect((error as Error).message).toBe(
			'enforce on "login": a cost must be a whole number from 1 to the burst of 5',
		);
	});
});

describe('peek', () => {
	test('answers what consume would, and writes nothing', async () => {
		const limit = login();
		const peeked = await limit.peek(ada, 2);
		expect(peeked).toMatchObject({ allowed: true, remaining: 3, limit: 5 });
		expect(await servers.redis.client.exists('login:10.0.0.1')).toBe(false);

		await limit.consume(ada, 4);
		const before = await servers.redis.client.get('login:10.0.0.1');
		expect(await limit.peek(ada, 2)).toMatchObject({
			allowed: false,
			remaining: 1,
		});
		expect(await servers.redis.client.get('login:10.0.0.1')).toBe(before);
	});

	test('a cost of 0 reads the bucket as it is', async () => {
		const limit = login();
		expect(await limit.peek(ada, 0)).toEqual({
			allowed: true,
			limit: 5,
			remaining: 5,
			resetAfter: 0,
			retryAfter: 0,
		});
		await limit.consume(ada, 5);
		const empty = await limit.peek(ada, 0);
		expect(empty.allowed).toBe(true);
		expect(empty.remaining).toBe(0);
		expect(empty.resetAfter).toBeGreaterThan(59_000);
	});

	test('refuses a cost from 0 to the burst only', async () => {
		const error = await rejection(login().peek(ada, 6));
		expect(error).toMatchObject({
			code: 'COST',
			message:
				'peek on "login": a cost must be a whole number from 0 to the burst of 5',
		});
	});
});

describe('reset', () => {
	test('refills the bucket, and says whether anything was counted', async () => {
		const limit = login();
		expect(await limit.reset(ada)).toBe(false);
		await consumeTimes(limit, 5);
		expect(await limit.reset(ada)).toBe(true);
		expect(await limit.consume(ada)).toMatchObject({
			allowed: true,
			remaining: 4,
		});
	});
});

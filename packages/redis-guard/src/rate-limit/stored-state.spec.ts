import { describe, expect, test } from 'bun:test';
import { consumeAt as consumeWith, useRedis } from '../../test/fixtures';
import { rejectionMessage } from '../../test/rejection';
import { bindRateLimit } from './bind-rate-limit';
import { defineRateLimit } from './define-rate-limit';
import type { Rate } from './gcra';

// What the script trusts in its key, and what a clock that moves back does.
// Ten a second, a burst of ten: one request is 1_000_000 ticks of 1/10 µs,
// the tolerance is 10_000_000, and a full refill takes 1_000_000 µs.

const servers = useRedis();
const NOW = 1_790_000_000_123_457;
const RATE: Rate = { limit: 10, per: 1000, burst: 10 };
const SECOND = 1_000_000;
const KEY = 'state';

const consumeAt = (now: number, cost = 1, write = true) =>
	consumeWith(servers.redis.client, KEY, RATE, cost, now, write);

/*
 * A script that never returns would block the server for good. Each test
 * here that could hang has a 1 s timeout, so a regression fails instead of
 * freezing the run. Measured with the correction loops unbounded again: the
 * test fails at 1000 ms, and Bun then kills the file's redis-server as a
 * dangling process ("killed 2 dangling processes"), so every later test in
 * this file fails too — a SCRIPT KILL from another connection does free the
 * server (measured), but there is no server left to free. The first failure
 * is the one to read.
 */

/** Stores a raw value, as somebody else's code or a hand edit might. */
const store = (value: string) => servers.redis.client.set(KEY, value);

/** Consumes once and says how long the script took, in milliseconds. */
async function timed(now: number) {
	const started = performance.now();
	const result = await consumeAt(now);
	return { result, took: performance.now() - started };
}

describe('a stored value this script could not have written', () => {
	test('a field of more than 16 digits is a full bucket, promptly', async () => {
		await store('1 99999999999999999999');
		const { result, took } = await timed(NOW);
		expect(result).toMatchObject({ allowed: true, remaining: 9 });
		expect(took).toBeLessThan(100);
	}, 1000);

	test('an ahead above the tolerance is a full bucket, promptly', async () => {
		// 16 digits, above 2^53, at a limit of 1: ceil(ahead / limit) is past
		// 2^53, where q − 1 equals q, and an unbounded correction loop spun
		// there for good, holding the server BUSY until SCRIPT KILL.
		await store(`${NOW} 9999999999999999`);
		const started = performance.now();
		const result = await consumeWith(
			servers.redis.client,
			KEY,
			{ limit: 1, per: 1000, burst: 10 },
			1,
			NOW,
		);
		expect(result).toMatchObject({ allowed: true, remaining: 9 });
		expect(performance.now() - started).toBeLessThan(100);
	}, 1000);

	test('an ahead between the tolerance and 2^53 is a full bucket, and gets a PX', async () => {
		// Once denied for about a year, from a key with no expiry at all.
		await store(`${NOW} 5000000000000000`);
		expect(await servers.redis.client.pttl(KEY)).toBe(-1);
		const result = await consumeAt(NOW);
		expect(result).toMatchObject({ allowed: true, remaining: 9 });
		expect(await servers.redis.client.get(KEY)).toBe(`${NOW} 1000000`);
		expect(await servers.redis.client.pttl(KEY)).toBeGreaterThan(0);
	}, 1000);

	test('a base more than a full refill ahead of now is a full bucket', async () => {
		await store(`${NOW + SECOND + 1} 5000000`);
		expect(await consumeAt(NOW)).toMatchObject({ allowed: true, remaining: 9 });
		expect(await servers.redis.client.get(KEY)).toBe(`${NOW} 1000000`);
	}, 1000);

	test('a base exactly a full refill ahead is kept, and nothing drains', async () => {
		await store(`${NOW + SECOND} 5000000`);
		expect(await consumeAt(NOW)).toMatchObject({ allowed: true, remaining: 4 });
		expect(await servers.redis.client.get(KEY)).toBe(`${NOW + SECOND} 6000000`);
	}, 1000);

	test('anything else is a full bucket', async () => {
		for (const value of ['', 'x', '1', '1 2 3', '-1 5', '1.5 2', ' 1 2']) {
			await store(value);
			const result = await consumeAt(NOW);
			expect({ value, remaining: result.remaining }).toEqual({
				value,
				remaining: 9,
			});
		}
	}, 1000);
});

describe('a clock that moves back', () => {
	test('two clocks a second apart, alternating, allow exactly the burst', async () => {
		// A failover between two servers whose clocks disagree by a second:
		// nine calls on the one ahead, then one on the one behind, five times.
		// Counting from whichever clock answered, each switch forward drained
		// a second — a full bucket — again: 50 allowed out of 50.
		let allowed = 0;
		for (let round = 0; round < 5; round += 1) {
			for (let i = 0; i < 9; i += 1) {
				if ((await consumeAt(NOW + SECOND)).allowed) allowed += 1;
			}
			if ((await consumeAt(NOW)).allowed) allowed += 1;
		}
		expect(allowed).toBe(RATE.burst);
	});

	test('one step back allows nothing the forward clock would not', async () => {
		for (const back of [1, 250_000, SECOND]) {
			for (const taken of [0, 3, 10]) {
				await servers.redis.client.del(KEY);
				if (taken > 0) await consumeAt(NOW, taken);
				const forward = await consumeAt(NOW, 1, false);
				const behind = await consumeAt(NOW - back, 1, false);
				const where = { back, taken };
				expect({ ...where, allowed: behind.allowed }).toEqual({
					...where,
					allowed: forward.allowed,
				});
				expect(behind.remaining).toBe(forward.remaining);
				expect(behind.retryAfter).toBeGreaterThanOrEqual(forward.retryAfter);
			}
		}
	});

	test('a write behind the latest time keeps that time, and expires from now', async () => {
		await consumeAt(NOW + SECOND / 2, 2);
		await consumeAt(NOW, 1);
		// The later base stays; the key lives for what is ahead of it, plus
		// the half second this clock must still pass to reach it.
		expect(await servers.redis.client.get(KEY)).toBe(
			`${NOW + SECOND / 2} 3000000`,
		);
		const pttl = await servers.redis.client.pttl(KEY);
		expect(pttl).toBeGreaterThan(700);
		expect(pttl).toBeLessThanOrEqual(800);
	});
});

describe('a key of another type', () => {
	const clash = defineRateLimit({
		name: 'clash',
		key: (p: { id: string }) => p.id,
		limit: 10,
		per: 1000,
	});

	test('fails consume and peek with Redis’s WRONGTYPE, and reset deletes it', async () => {
		const { client } = servers.redis;
		await client.hset('clash:a', 'field', 'theirs');
		const limit = bindRateLimit(client, clash);
		// Each call made where it is held, as test/rejection.ts asks.
		for (const call of [
			() => limit.consume({ id: 'a' }),
			() => limit.peek({ id: 'a' }),
		]) {
			expect(await rejectionMessage(call())).toStartWith(
				'WRONGTYPE Operation against a key holding the wrong kind of value',
			);
		}
		// Nothing was written over it.
		expect(await client.hget('clash:a', 'field')).toBe('theirs');
		// DEL takes any type: reset removes somebody else's key as readily.
		expect(await limit.reset({ id: 'a' })).toBe(true);
		expect(await client.exists('clash:a')).toBe(false);
	});
});

import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { bindRateLimit } from './bind-rate-limit';
import { defineRateLimit } from './define-rate-limit';

// Rates whose interval — per × 1000 ÷ limit microseconds — is not whole, and
// whose tolerance — burst × interval — is not whole either. Rounding the TAT
// to the microsecond once made a full burst on an empty bucket unreachable
// for exactly these: refused with remaining = burst, forever.

const servers = useRedis();

function limitOf(limit: number, per: number, burst: number) {
	const definition = defineRateLimit({
		name: `r${limit}-${per}-${burst}`,
		key: (id: string) => id,
		limit,
		per,
		burst,
	});
	return bindRateLimit(servers.redis.client, definition);
}

describe('a fractional interval', () => {
	test('a whole burst on an empty bucket is allowed, and leaves nothing', async () => {
		for (const [limit, per, burst] of [
			[3, 1000, 2],
			[7, 1000, 5],
			[3, 1000, 3],
			[999, 1000, 10],
		] as const) {
			const result = await limitOf(limit, per, burst).consume('a', burst);
			expect({ rate: `${limit}/${per}/${burst}`, ...result }).toMatchObject({
				allowed: true,
				remaining: 0,
				retryAfter: 0,
			});
		}
	});

	test('remaining and the decision never disagree', async () => {
		const rates = [
			[3, 1000, 2],
			[3, 1000, 5],
			[7, 1000, 5],
			[1, 3, 4],
			[500, 1, 7],
			[999, 1000, 10],
		] as const;
		for (const [limit, per, burst] of rates) {
			const rate = limitOf(limit, per, burst);
			for (const cost of [1, 2, Math.min(3, burst)]) {
				await rate.reset('a');
				for (let i = 0; i < burst + 3; i += 1) {
					const result = await rate.consume('a', cost);
					const where = `${limit}/${per}/${burst}, cost ${cost}, call ${i}`;
					if (!result.allowed) {
						// A denial never says there was room for it.
						expect({ where, remaining: result.remaining < cost }).toEqual({
							where,
							remaining: true,
						});
						expect(result.retryAfter).toBeGreaterThan(0);
						break;
					}
					// What an allowed call says is left is really there: a later
					// check, with at least as much refilled, allows all of it.
					if (result.remaining > 0) {
						const check = await rate.peek('a', result.remaining);
						expect({ where, allowed: check.allowed }).toEqual({
							where,
							allowed: true,
						});
					}
				}
			}
		}
	});

	test('waiting retryAfter is enough, at a rate that is not whole', async () => {
		// One every 3 ms, four at once: an interval of 3000 µs, and a cost of
		// 3 that is then refused for a fraction of a millisecond or more.
		for (const [limit, per, burst, cost] of [
			[1, 3, 4, 3],
			[7, 1000, 5, 2],
		] as const) {
			const rate = limitOf(limit, per, burst);
			let denied = await rate.consume('w', cost);
			while (denied.allowed) denied = await rate.consume('w', cost);
			await Bun.sleep(denied.retryAfter);
			expect((await rate.consume('w', cost)).allowed).toBe(true);
		}
	});
});

describe('the stored TAT', () => {
	test('is written exactly, and Lua reads back the double it wrote', async () => {
		const rate = limitOf(7, 1000, 5);
		const client = servers.redis.client;
		for (let i = 0; i < 4; i += 1) {
			await rate.consume('t');
			const stored = await client.get('r7-1000-5:t');
			if (stored === null) throw new Error('nothing stored');
			// At most two decimals, a multiple of a quarter, and the same text
			// once parsed and printed again — in JavaScript and in Lua.
			expect(stored).toMatch(/^\d+\.\d{2}$/);
			expect(Number.isInteger(Number(stored) * 4)).toBe(true);
			expect(Number(stored).toFixed(2)).toBe(stored);
			const again = await client.eval(
				"return string.format('%.2f', tonumber(ARGV[1]))",
				0,
				stored,
			);
			expect(again).toBe(stored);
		}
	});

	test('two decimals hold every double between 2^50 and 2^53 µs', () => {
		// 2^50 µs is 2005 and 2^53 µs is 2255: every TAT this package writes.
		// The step there is 0.25, 0.5 or 1, so no double needs a third place.
		for (const base of [2 ** 50, 1.79e15, 2 ** 51, 2 ** 52]) {
			for (let k = 0; k < 2000; k += 1) {
				const x = base + k * (2000 / 7) + k / 3;
				expect(Number(x.toFixed(2))).toBe(x);
			}
		}
	});
});

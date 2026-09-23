import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { bindRateLimit } from './bind-rate-limit';
import { defineRateLimit } from './define-rate-limit';

// Rates whose interval — per × 1000 ÷ limit microseconds — is not whole, and
// whose tolerance — burst × interval — is not whole either. While the TAT was
// a float of microseconds, rounding it to the microsecond made a full burst
// on an empty bucket unreachable for exactly these: refused with remaining =
// burst, forever. In ticks of 1/limit µs every one of them is whole.

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

describe('the stored state', () => {
	test('is two integers, and drains by exactly limit ticks a microsecond', async () => {
		// 7 a second, burst 5: one request is per × 1000 = 1_000_000 ticks of
		// 1/7 µs — a whole number, where it is 142857.142… µs.
		const rate = limitOf(7, 1000, 5);
		const client = servers.redis.client;
		await rate.consume('t');
		const first = await client.get('r7-1000-5:t');
		expect(first).toMatch(/^\d+ 1000000$/);
		await Bun.sleep(5);
		await rate.consume('t');
		const second = await client.get('r7-1000-5:t');
		expect(second).toMatch(/^\d+ \d+$/);
		const [base1, ahead1] = (first ?? '').split(' ').map(Number);
		const [base2, ahead2] = (second ?? '').split(' ').map(Number);
		if (base1 === undefined || base2 === undefined) throw new Error('no base');
		// What was left after the elapsed microseconds, plus one request.
		expect(ahead2).toBe((ahead1 ?? 0) - (base2 - base1) * 7 + 1_000_000);
	});
});

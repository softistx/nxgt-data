import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { runScript } from '../scripts/run-script';
import { GCRA_AT_ARGV, type Rate, toResult } from './gcra';

// The script as it runs, with `now` given rather than read: at one instant
// nothing refills, so a burst taken one request at a time must allow exactly
// the burst — no more, which drift in the caller's favour gives, and no
// fewer, which drift against it gives. Both were measured on the float TAT
// this replaced: 21 per 10 s with a burst of 1000 allowed 1049, and 7 per
// second with a burst of 5 fell short.

const servers = useRedis();
const NOW = 1_790_000_000_123_457; // µs, near the present

async function consumeAt(
	key: string,
	rate: Rate,
	cost: number,
	now: number,
	write = true,
) {
	const reply = await runScript(
		servers.redis.client,
		GCRA_AT_ARGV,
		[key],
		[rate.per, rate.limit, rate.burst, cost, write ? 1 : 0, now],
	);
	return toResult(reply, rate);
}

const rates: Rate[] = [
	{ limit: 21, per: 10_000, burst: 100 },
	{ limit: 21, per: 10_000, burst: 1000 },
	{ limit: 53, per: 25_000, burst: 1000 },
	{ limit: 7, per: 3000, burst: 1000 },
	{ limit: 503, per: 25_000, burst: 1000 },
	{ limit: 7, per: 1000, burst: 2 },
	{ limit: 7, per: 1000, burst: 5 },
	{ limit: 7, per: 1000, burst: 10 },
	{ limit: 7, per: 1000, burst: 100 },
	{ limit: 3, per: 1000, burst: 2 },
	{ limit: 500, per: 1, burst: 7 },
	// Refused while time was a float of microseconds; exact in ticks.
	{ limit: 8000, per: 1, burst: 5 },
	{ limit: 10_000_000, per: 1000, burst: 5 },
];

describe('at one instant', () => {
	test('a burst taken one at a time allows exactly the burst', async () => {
		for (const rate of rates) {
			const key = `fixed:${rate.limit}/${rate.per}/${rate.burst}`;
			let allowed = 0;
			let last = await consumeAt(key, rate, 1, NOW);
			while (last.allowed) {
				allowed += 1;
				// remaining counts down by exactly one each time.
				expect({ key, remaining: last.remaining }).toEqual({
					key,
					remaining: rate.burst - allowed,
				});
				if (allowed > rate.burst) break;
				last = await consumeAt(key, rate, 1, NOW);
			}
			expect({ key, allowed }).toEqual({ key, allowed: rate.burst });
			expect(last.remaining).toBe(0);
			expect(last.retryAfter).toBeGreaterThan(0);
		}
	});

	test('a whole burst in one call is allowed, and one more is not', async () => {
		for (const rate of rates) {
			const key = `whole:${rate.limit}/${rate.per}/${rate.burst}`;
			const all = await consumeAt(key, rate, rate.burst, NOW);
			expect({ key, ...all }).toMatchObject({
				key,
				allowed: true,
				remaining: 0,
			});
			expect((await consumeAt(key, rate, 1, NOW)).allowed).toBe(false);
		}
	});

	test('after one request at 7 a second, remaining is the rest of the burst', async () => {
		const two = await consumeAt(
			'seven:2',
			{ limit: 7, per: 1000, burst: 2 },
			1,
			NOW,
		);
		expect(two.remaining).toBe(1);
		const five = await consumeAt(
			'seven:5',
			{ limit: 7, per: 1000, burst: 5 },
			1,
			NOW,
		);
		expect(five.remaining).toBe(4);
	});

	test('refills exactly: one interval later, exactly one more fits', async () => {
		// 7 a second: one request every 142857.142… µs, so 142858 µs is the
		// first whole microsecond at which the next one fits.
		const rate = { limit: 7, per: 1000, burst: 3 };
		await consumeAt('refill', rate, 3, NOW);
		expect(
			(await consumeAt('refill', rate, 1, NOW + 142_857, false)).allowed,
		).toBe(false);
		const next = await consumeAt('refill', rate, 1, NOW + 142_858);
		expect(next).toMatchObject({ allowed: true, remaining: 0 });
		expect((await consumeAt('refill', rate, 1, NOW + 142_858)).allowed).toBe(
			false,
		);
	});
});

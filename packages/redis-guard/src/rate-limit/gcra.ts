import type { RedisClient } from 'bun';
import { defineScript, runScript, type Script } from '../scripts/run-script';
import type { LimitResult } from './types';

/**
 * GCRA — the generic cell rate algorithm — as one script over one key, in
 * **exact integers**.
 *
 * The unit is a *tick*, 1/limit of a microsecond. In ticks, one request is
 * `per × 1000` — a whole number whatever the rate — the tolerance is
 * `burst × per × 1000`, and a cost of n is n requests' worth. A double holds
 * every integer below 2^53 exactly, and `defineRateLimit` refuses a
 * tolerance above that, so no value here is ever rounded: the three earlier
 * versions kept the theoretical arrival time (TAT) as a float of microseconds
 * near 1.8e15, which cannot hold `cost × interval` exactly, and each way of
 * rounding it drifted — in the caller's favour at 21 per 10 s, against it at
 * 7 per second, and unreachably at 3 per second with a burst of 2.
 *
 * The key holds two integers, `"<base> <ahead>"`: `base` is the server's
 * `TIME` in microseconds at the last write, and `ahead` is how far the TAT
 * was beyond it, in ticks. At a call, `elapsed` microseconds drain
 * `elapsed × limit` ticks, and what is left, `d`, decides.
 *
 * - `now` is `TIME`, read inside the script, never the caller's clock — and
 *   a clock that went back drains nothing rather than filling the bucket.
 * - It is **one** script, so the read, the decision and the write are one
 *   step: two processes cannot both read the same state and both be allowed.
 * - A denial writes nothing, and neither does a `peek`.
 * - The key expires when the bucket would be full again, so an idle limit
 *   leaves nothing behind.
 * - The decision is `cost × per × 1000 <= tolerance − d`, and `remaining` is
 *   the largest n passing the same test, so they cannot disagree. Each side
 *   stays at or below the tolerance, so each is exact.
 * - A division by a double can round to the next integer, so every integer
 *   division is settled by multiplying back, and every product compared to
 *   an exact integer is either exact itself or so large that its rounding
 *   cannot change the comparison.
 *
 * ARGV: `per` (ms), `limit`, `burst`, `cost`, and `1` to write or `0` not to.
 * Returns `{ allowed, remaining, resetAfter, retryAfter }`, the last two in
 * milliseconds, rounded up so that waiting that long is always enough.
 */
function gcraSource(now: string): string {
	return `
local now = ${now}
local per = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local unit = per * 1000
local tolerance = burst * unit

-- ceil(a / b) for integers a >= 0 and b >= 1, settled by multiplication.
local function ceildiv(a, b)
	local q = math.ceil(a / b)
	while q > 0 and (q - 1) * b >= a do q = q - 1 end
	while q * b < a do q = q + 1 end
	return q
end
-- Ticks to milliseconds, rounded up: ceil(ceil(t / limit) / 1000) is
-- ceil(t / (limit * 1000)), without the product, which may not be exact.
local function ms(ticks)
	return ceildiv(ceildiv(ticks, limit), 1000)
end
-- The most requests of cost 1 that fit in free ticks.
local function left(free)
	if free <= 0 then return 0 end
	local n = math.floor(free / unit)
	if n > burst then n = burst end
	while n > 0 and n * unit > free do n = n - 1 end
	while n < burst and (n + 1) * unit <= free do n = n + 1 end
	return n
end

local d = 0
local stored = redis.call('GET', KEYS[1])
if stored then
	local base, ahead = string.match(stored, '^(%d+) (%d+)$')
	base = tonumber(base)
	ahead = tonumber(ahead)
	if base and ahead then
		local elapsed = now - base
		if elapsed < 0 then elapsed = 0 end
		-- Exact below 2^53; above it, certainly more than ahead.
		local drained = elapsed * limit
		if drained < ahead then d = ahead - drained end
	end
end

local free = tolerance - d
local need = cost * unit
if need > free then
	return {0, left(free), ms(d), ms(need - free)}
end
local after = d + need
if ARGV[5] == '1' and cost > 0 then
	redis.call('SET', KEYS[1], string.format('%.0f %.0f', now, after),
		'PX', string.format('%.0f', ms(after)))
end
return {1, left(free - need), ms(after), 0}
`;
}

/** The script, timed by the server's own clock. */
const GCRA = defineScript(
	gcraSource(
		"(function() local t = redis.call('TIME') return tonumber(t[1]) * 1000000 + tonumber(t[2]) end)()",
	),
);

/**
 * The same script with `now` taken from `ARGV[6]`, in microseconds. **For
 * the specs only**, which need many calls at one instant; nothing exported
 * from the package reaches it.
 */
export const GCRA_AT_ARGV: Script = defineScript(
	gcraSource('tonumber(ARGV[6])'),
);

/** What the script needs from a definition, resolved. */
export interface Rate {
	readonly limit: number;
	readonly per: number;
	readonly burst: number;
}

/** Turns the script's reply into a result. */
export function toResult(reply: unknown, rate: Rate): LimitResult {
	const [allowed, remaining, resetAfter, retryAfter] = reply as [
		number,
		number,
		number,
		number,
	];
	return {
		allowed: allowed === 1,
		limit: rate.burst,
		remaining,
		resetAfter,
		retryAfter,
	};
}

/** Runs the script once, counting `cost` when `write` is true. */
export async function checkRate(
	client: RedisClient,
	key: string,
	rate: Rate,
	cost: number,
	write: boolean,
): Promise<LimitResult> {
	const reply = await runScript(
		client,
		GCRA,
		[key],
		[rate.per, rate.limit, rate.burst, cost, write ? 1 : 0],
	);
	return toResult(reply, rate);
}

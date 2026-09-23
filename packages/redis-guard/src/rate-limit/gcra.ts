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
 * every integer up to 2^53 − 1 exactly, and `defineRateLimit` refuses a
 * tolerance above that, so no value here is ever rounded: the three earlier
 * versions kept the theoretical arrival time (TAT) as a float of microseconds
 * near 1.8e15, which cannot hold `cost × interval` exactly, and each way of
 * rounding it drifted — in the caller's favour at 21 per 10 s, against it at
 * 7 per second, and unreachably at 3 per second with a burst of 2.
 *
 * The key holds two integers, `"<base> <ahead>"`: `base` is the latest
 * server `TIME` the bucket has seen, in microseconds, and `ahead` is how far
 * the TAT was beyond it, in ticks. At a call, the microseconds since `base`
 * drain `elapsed × limit` ticks, and what is left, `d`, decides.
 *
 * - `now` is `TIME`, read inside the script, never the caller's clock. A
 *   clock that goes back by at most a full refill never refills: `base`
 *   only moves forward, so the bucket carries on from the latest time it
 *   has seen, and a failover between two servers whose clocks disagree by
 *   at most that cannot count one stretch of time twice. The key's `PX` is
 *   counted from `now`, the server's own clock for the expiry, plus how far
 *   `base` is ahead of it.
 * - A stored value is used only if it is a state this script could have
 *   written: two digit strings of at most 16 digits, each at most 2^53 − 1,
 *   `ahead` at most the tolerance, and `base` ahead of `now` by at most a
 *   full refill. Anything else — somebody else's value, a hand-edited key —
 *   is a full bucket (nothing counted), which the next allowed call overwrites with a `PX`.
 * - It is **one** script, so the read, the decision and the write are one
 *   step: two processes cannot both read the same state and both be allowed.
 * - A denial writes nothing, and neither does a `peek`.
 * - The decision is `cost × per × 1000 <= tolerance − d`, and `remaining` is
 *   the largest n passing the same test, so they cannot disagree. Each side
 *   stays at or below the tolerance, so each is exact.
 * - Every integer division takes a double's estimate, which is within one of
 *   the answer when both operands are at most 2^53 — which the checks above
 *   guarantee for every call below — and corrects it by **one** step each
 *   way, multiplying back. No loop depends on the input, so no stored value
 *   can keep the script running. `elapsed × limit` may exceed 2^53, but it
 *   is only compared with `ahead`, an exact integer at most the tolerance,
 *   which its rounding cannot reverse.
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
local SAFE = 9007199254740991

-- ceil(a / b) for integers 0 <= a <= 2^53 and 1 <= b <= 2^53: the double
-- estimate is within one, so one step each way settles it.
local function ceildiv(a, b)
	local q = math.ceil(a / b)
	if q > 0 and (q - 1) * b >= a then q = q - 1 end
	if q * b < a then q = q + 1 end
	return q
end
-- Ticks to milliseconds, rounded up: ceil(ceil(t / limit) / 1000) is
-- ceil(t / (limit * 1000)), without the product, which may not be exact.
local function ms(ticks)
	return ceildiv(ceildiv(ticks, limit), 1000)
end
-- The most requests of cost 1 that fit in free ticks (free <= tolerance).
local function left(free)
	if free <= 0 then return 0 end
	local n = math.floor(free / unit)
	if n > burst then n = burst end
	if n > 0 and n * unit > free then n = n - 1 end
	if n < burst and (n + 1) * unit <= free then n = n + 1 end
	return n
end

-- A stored state, only if this script could have written it.
local function state(stored)
	if not stored then return nil end
	local b, a = string.match(stored, '^(%d+) (%d+)$')
	if not b or #b > 16 or #a > 16 then return nil end
	b = tonumber(b)
	a = tonumber(a)
	if b > SAFE or a > tolerance then return nil end
	if b > now and b - now > ceildiv(tolerance, limit) then return nil end
	return b, a
end

local base, d = now, 0
local seen, ahead = state(redis.call('GET', KEYS[1]))
if seen then
	if seen > now then
		base, d = seen, ahead
	else
		local drained = (now - seen) * limit
		if drained < ahead then d = ahead - drained end
	end
end
-- How far base is ahead of this server's clock, in ms, rounded up: time
-- this clock must pass before the bucket drains at all.
local lag = ceildiv(base - now, 1000)

local free = tolerance - d
local need = cost * unit
if need > free then
	return {0, left(free), ms(d) + lag, ms(need - free) + lag}
end
local after = d + need
if ARGV[5] == '1' and cost > 0 then
	redis.call('SET', KEYS[1], string.format('%.0f %.0f', base, after),
		'PX', string.format('%.0f', ms(after) + lag))
end
return {1, left(free - need), ms(after) + lag, 0}
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

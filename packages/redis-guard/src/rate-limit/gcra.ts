import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../scripts/run-script';
import type { LimitResult } from './types';

/**
 * GCRA — the generic cell rate algorithm — as one script over one key.
 *
 * The key holds one number: the **theoretical arrival time** (TAT), in
 * microseconds on the server's clock — the moment the bucket would be empty
 * again if every request counted so far had arrived exactly at the rate.
 * Each request pushes it `interval` further; a request is allowed while the
 * TAT it would leave is no more than `tolerance` ahead of now.
 *
 * - `now` is `TIME`, read inside the script, never the caller's clock: every
 *   process that shares the limit then measures against one clock, and a
 *   host whose clock is wrong cannot refill a bucket or empty it.
 * - It is **one** script, so the read, the decision and the write are one
 *   step: two processes cannot both read the same TAT and both be allowed.
 * - A denial writes nothing, and neither does a `peek`.
 * - The key expires when the bucket would be full again, so an idle limit
 *   leaves nothing behind.
 * - Numbers are written with `%.0f`, never `tostring`, which would give
 *   `1.79e+15`; and only integers are returned, because Redis truncates a Lua
 *   number to an integer reply anyway.
 *
 * ARGV: `per` (ms), `limit`, `burst`, `cost`, and `1` to write or `0` not to.
 * Returns `{ allowed, remaining, resetAfter, retryAfter }`, the last two in
 * milliseconds, rounded up so that waiting that long is always enough.
 */
const GCRA = defineScript(`
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local interval = tonumber(ARGV[1]) * 1000 / tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local tolerance = interval * burst

local tat = tonumber(redis.call('GET', KEYS[1]))
if tat == nil or tat < now then tat = now end

local function ms(us)
	return math.ceil(us / 1000)
end
-- How many requests of cost 1 fit before the TAT would pass the tolerance.
-- The extra microsecond absorbs the rounding up of a stored TAT, which
-- could otherwise read one request short when the interval is not whole.
-- It is less than an interval, because an interval is at least 2 µs —
-- defineRateLimit refuses a faster rate — so it can never add a request.
local function left(t)
	local n = math.floor((tolerance - (t - now) + 1) / interval)
	if n < 0 then return 0 end
	if n > burst then return burst end
	return n
end

-- Rounded up to the microsecond, before the decision: rounding never goes in
-- the caller's favour, and what is decided on is exactly what is stored.
local newTat = math.ceil(tat + cost * interval)
local allowAt = newTat - tolerance
if allowAt > now then
	return {0, left(tat), ms(tat - now), ms(allowAt - now)}
end
if ARGV[5] == '1' and cost > 0 then
	redis.call('SET', KEYS[1], string.format('%.0f', newTat),
		'PX', string.format('%.0f', ms(newTat - now)))
end
return {1, left(newTat), ms(newTat - now), 0}
`);

/** What the script needs from a definition, resolved. */
export interface Rate {
	readonly limit: number;
	readonly per: number;
	readonly burst: number;
}

/** Runs the script once, counting `cost` when `write` is true. */
export async function checkRate(
	client: RedisClient,
	key: string,
	rate: Rate,
	cost: number,
	write: boolean,
): Promise<LimitResult> {
	const reply = (await runScript(
		client,
		GCRA,
		[key],
		[rate.per, rate.limit, rate.burst, cost, write ? 1 : 0],
	)) as [number, number, number, number];
	const [allowed, remaining, resetAfter, retryAfter] = reply;
	return {
		allowed: allowed === 1,
		limit: rate.burst,
		remaining,
		resetAfter,
		retryAfter,
	};
}

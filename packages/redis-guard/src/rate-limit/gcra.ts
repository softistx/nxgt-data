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
 * - The TAT is stored **exactly**, with `%.2f` — never `tostring`, which
 *   would give `1.79e+15`, and never rounded to the microsecond, which once
 *   made a full burst on an empty bucket unreachable. A double between 2^50
 *   and 2^51 µs (2005 to 2041) steps by 0.25, and from there to 2^53 by 0.5
 *   or 1, so its decimal expansion has at most two places: `%.2f` prints it
 *   exactly and `tonumber` reads the same double back. Only integers are
 *   returned, because Redis truncates a Lua number to an integer reply.
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

-- How far ahead of now the TAT is, 0 for a full bucket. Everything below
-- is an offset from now: the difference of two nearby doubles is exact, and
-- an empty bucket's offset is exactly 0, so burst * interval compares
-- equal to the tolerance it is.
local ahead = 0
local tat = tonumber(redis.call('GET', KEYS[1]))
if tat ~= nil and tat > now then ahead = tat - now end

-- The one comparison: whether n more requests fit from an offset. The
-- decision and remaining both use it, so they cannot disagree.
local function fits(d, n)
	return d + n * interval <= tolerance
end
-- The most requests of cost 1 that fit: estimated by division, then settled
-- by the comparison itself, which is monotonic in n.
local function left(d)
	local n = math.floor((tolerance - d) / interval)
	if n < 0 then n = 0 end
	if n > burst then n = burst end
	while n > 0 and not fits(d, n) do n = n - 1 end
	while n < burst and fits(d, n + 1) do n = n + 1 end
	return n
end
local function ms(us)
	return math.ceil(us / 1000)
end

if not fits(ahead, cost) then
	return {0, left(ahead), ms(ahead), ms(ahead + cost * interval - tolerance)}
end
-- The new TAT, as the double it is: %.2f writes it exactly, since near
-- now a double's step is a quarter of a microsecond. The offset is taken
-- back from that double, so what this call reports is what the next call
-- reads.
local newTat = now + ahead + cost * interval
local after = newTat - now
if ARGV[5] == '1' and cost > 0 then
	redis.call('SET', KEYS[1], string.format('%.2f', newTat),
		'PX', string.format('%.0f', ms(after)))
end
return {1, left(after), ms(after), 0}
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

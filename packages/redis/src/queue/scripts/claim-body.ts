import { GCRA_FN } from '../../rate-limit/gcra';
import { SCHEDULE_FIELDS, SCHEDULE_SOUND_FN } from './schedule';
import { WAKE_FN } from './wake';

/*
 * The trust rule of the queue's scripts, as the guards' (see
 * `idempotency/scripts.ts`): a job hash is read only if this package could
 * have written it. The claim needs exactly `data`, `attempt`, `attempts` and
 * `priority`, the last three numeric, and a `timeout` that is either absent
 * or a whole number of ms, at least 1; other fields (`step:<name>`,
 * `progress`, `result`, `group`) are later scripts' and never a reason to
 * refuse. A hash that fails the check is moved to `failed` with an `INVALID`
 * error and reported, never run and never "repaired"; an id whose hash is
 * gone is just removed from the set, and named in no reply.
 *
 * Every loop has its cap: reclaim 100, promote 1000, pop `n`.
 */

/**
 * Publishes a job's final outcome on the queue's `events` channel (the key
 * after the seven of `CLAIM_FN`). The message is the JSON of `{type, id}` with the
 * stored JSON texts (`result`, `error`) spliced in as they are, not decoded
 * and encoded again: `cjson` writes numbers with 14 digits and an empty array
 * as `{}`, so a round trip through it would change a result. They are texts
 * this package wrote with `JSON.stringify`, which is why they may be spliced;
 * `type` and `id` go through `cjson.encode`, as strings are safe in it.
 * `field` is `'result'` or `'error'`, `json` is `''` for none.
 */
const PUBLISH_FN = `
local function publish(events, kind, id, field, json)
	local message = '{"type":' .. cjson.encode(kind) .. ',"id":' .. cjson.encode(id)
	if json ~= '' then message = message .. ',"' .. field .. '":' .. json end
	redis.call('PUBLISH', events, message .. '}')
end
`;

/**
 * The claim step, one Lua function, concatenated into `CLAIM`, `COMPLETE`
 * and `FAIL` so a single body exists. The including script defines
 * `local prefix` (the job-key prefix, inside the queue's slot) first.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake (a script may
 * be given more keys after these, as {@link scriptKeys} appends `events`,
 * `paused` (KEYS[9]), `rate` (KEYS[10], the queue-wide GCRA state) and
 * `schedules` (KEYS[11])).
 * `claim(n, lease, tokens, now, rate, sprefix)` takes a table of at least `n`
 * tokens, one per slot, and the schedule-hash key prefix, and returns
 * `{jobs, stalled, invalid, next, due}`, each job being
 * `{id, data, attempt, attempts, token, timeout}` (`timeout` in ms, `-1` for
 * none), and `due` the schedules to fire (see below):
 *
 * 1. reclaims up to 100 `active` ids whose score is below `now`. The attempt
 *    was counted when the lease began, so a job that kills its process does
 *    not loop forever: with attempts left it goes back to `ready` with the
 *    score rebuilt from its stored `priority` and a fresh `INCR seq`,
 *    otherwise to `failed` as `LeaseLapsed`;
 * 2. promotes up to 1000 due `delayed` ids to `ready`;
 * 3. pops up to `n` from `ready`, marking each `active` with its token,
 *    `attempt + 1` and a lease ending at `now + lease`. While `paused`
 *    exists (1 and 2 still run, so `counts` stays honest) it pops nothing;
 * 4. leaves one `wake` token when `ready` still holds jobs (none if one is
 *    there), so a blocked peer takes over; deletes `wake` when it is empty,
 *    and also while paused or rate-limited: a token there would make every
 *    worker spin on claims that pop nothing;
 * 5. gives the ms until the first `delayed` score, `-1` when it is empty,
 *    5000 while paused (the worker's own cap: it only has to notice a lost
 *    resume token), and, while the rate refuses the jobs in `ready`, the
 *    GCRA's `retryAfter` for one job when that is sooner;
 * 6. reports up to 20 schedules due now (`schedules` scored at or below
 *    `now`, earliest first) as `{id, kind, spec, timezone, due}`, paused or
 *    not: schedules fire while paused. The claim fires nothing: the client
 *    computes each `next` and calls `FIRE`. A hash that fails
 *    `schedule_sound` is left out and left alone. `next` is also bounded by
 *    the first schedule not yet due, and is 0 while a sound one is due.
 *
 * `rate` is `{per, limit, burst, us}` (`us` the script's `TIME` in µs, `per`
 * in ms) or `nil` for no limit. The pop is bounded by what a GCRA peek at
 * cost 1 admits (its `remaining` plus the one it spends): `min(n, remaining +
 * 1)`, or 0 when the peek is denied. Once `k` jobs have started, `k` is
 * charged in one write, only when `k > 0`: a reclaim, a promotion, a job
 * refused as invalid, charge nothing. The state is read at the script's own
 * clock, so every process shares one bucket.
 */
export const CLAIM_FN = `
${WAKE_FN}
${GCRA_FN}
${PUBLISH_FN}
${SCHEDULE_SOUND_FN}
local function int(x) return string.format('%d', x) end
-- tonumber alone would accept 'inf', 'nan', '1e3', '0x10', '-4' and '1.5':
-- an attempts of 'inf' would reclaim a crash-looping job forever, and a
-- priority of 5000 or 'inf' has no ready score, and a timeout of 'inf' would
-- never fire. This package writes whole decimal numbers only, so only those
-- are trusted. A timeout is at most 15 digits: past that a double no longer
-- holds it exactly, and 20 digits read back as garbage.
local function whole(v) return v and string.match(v, '^%d+$') ~= nil end
local function sound(f)
	return f[1] and whole(f[2]) and whole(f[3]) and whole(f[4])
		and tonumber(f[3]) >= 1 and tonumber(f[4]) <= 1000
		and (not f[5] or (whole(f[5]) and #f[5] <= 15 and tonumber(f[5]) >= 1))
end
local function ready_score(priority)
	return int(tonumber(priority) * 1099511627776 + redis.call('INCR', KEYS[6]))
end
local INVALID_ERROR = '{"name":"QueueError","message":"INVALID: a stored job this package could not have written"}'
local LAPSED_ERROR = '{"name":"LeaseLapsed","message":"lease lapsed"}'
-- An id whose hash is gone is only dropped; a hash this package could not
-- have written goes to failed, once, and is reported.
local function refuse(id, now, invalid)
	local key = prefix .. id
	redis.call('ZREM', KEYS[1], id)
	redis.call('ZREM', KEYS[2], id)
	redis.call('ZREM', KEYS[3], id)
	if redis.call('EXISTS', key) == 0 then return end
	redis.call('HSET', key, 'state', 'failed', 'error', INVALID_ERROR, 'finished', int(now))
	redis.call('HDEL', key, 'token')
	redis.call('ZADD', KEYS[5], int(now), id)
	publish(KEYS[8], 'failed', id, 'error', INVALID_ERROR)
	invalid[#invalid + 1] = id
end
-- The queue's rate from ARGV[i..i+2] (per ms, limit, burst; per 0 for none).
local function rate_of(i, us)
	local per = tonumber(ARGV[i])
	if per == 0 then return nil end
	return {per = per, limit = tonumber(ARGV[i + 1]), burst = tonumber(ARGV[i + 2]), us = us}
end
local function peek(rate, cost)
	return gcra(KEYS[10], rate.us, rate.per, rate.limit, rate.burst, cost, false)
end
-- How many jobs a claim of n may pop: none while paused or refused.
local function admitted(n, paused, rate)
	if paused then return 0 end
	if not rate then return n end
	local one = peek(rate, 1)
	if one[1] == 0 then return 0 end
	return math.min(n, one[2] + 1)
end
-- The schedules due now, up to 20 and only sound ones (skipped, never repaired),
-- each {id, kind, spec, timezone, due}; and the ms until the first one that is
-- not due yet. An unsound due schedule must not keep the wait at zero.
local function due_schedules(sprefix, now)
	local out = {}
	local rows = redis.call('ZRANGEBYSCORE', KEYS[11], '-inf', int(now), 'LIMIT', 0, 20, 'WITHSCORES')
	for i = 1, #rows, 2 do
		local f = redis.call('HMGET', sprefix .. rows[i], ${SCHEDULE_FIELDS})
		if schedule_sound(f) then
			out[#out + 1] = {rows[i], f[1], f[2], f[3] or '', tonumber(rows[i + 1])}
		end
	end
	return out
end
local function claim(n, lease, tokens, now, rate, sprefix)
	local jobs, stalled, invalid = {}, {}, {}
	local scheduled = due_schedules(sprefix, now)
	local lapsed = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. int(now), 'LIMIT', 0, 100)
	for _, id in ipairs(lapsed) do
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			redis.call('ZREM', KEYS[3], id)
			redis.call('HDEL', key, 'token')
			if tonumber(f[2]) < tonumber(f[3]) then
				redis.call('HSET', key, 'state', 'waiting')
				redis.call('ZADD', KEYS[2], ready_score(f[4]), id)
			else
				redis.call('HSET', key, 'state', 'failed', 'error', LAPSED_ERROR, 'finished', int(now))
				redis.call('ZADD', KEYS[5], int(now), id)
				publish(KEYS[8], 'failed', id, 'error', LAPSED_ERROR)
			end
			stalled[#stalled + 1] = id
		end
	end
	local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', int(now), 'LIMIT', 0, 1000)
	for _, id in ipairs(due) do
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			redis.call('ZREM', KEYS[1], id)
			redis.call('HSET', key, 'state', 'waiting')
			redis.call('ZADD', KEYS[2], ready_score(f[4]), id)
		end
	end
	local paused = redis.call('EXISTS', KEYS[9]) == 1
	local popped = {}
	local admit = admitted(n, paused, rate)
	if admit > 0 then popped = redis.call('ZPOPMIN', KEYS[2], admit) end
	for i = 1, #popped, 2 do
		local id = popped[i]
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			local token = tokens[#jobs + 1]
			local attempt = tonumber(f[2]) + 1
			redis.call('HSET', key, 'state', 'active', 'token', token, 'attempt', attempt)
			redis.call('ZADD', KEYS[3], int(now + lease), id)
			jobs[#jobs + 1] = {id, f[1], attempt, tonumber(f[3]), token, f[5] and tonumber(f[5]) or -1}
		end
	end
	if rate and #jobs > 0 then
		gcra(KEYS[10], rate.us, rate.per, rate.limit, rate.burst, #jobs, true)
	end
	-- Jobs wait in ready that the rate refuses: no token, so no worker spins.
	local ready = redis.call('ZCARD', KEYS[2]) > 0
	local retry = -1
	if rate and ready and not paused then
		local one = peek(rate, 1)
		if one[1] == 0 then retry = one[4] end
	end
	if not paused and ready and retry < 0 then
		wake(KEYS[7])
	else
		redis.call('DEL', KEYS[7])
	end
	if paused then return {jobs, stalled, invalid, 5000, scheduled} end
	local nextDue = -1
	local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
	if first[2] then nextDue = math.max(0, tonumber(first[2]) - now) end
	if #scheduled > 0 then
		nextDue = 0
	else
		local head = redis.call('ZRANGEBYSCORE', KEYS[11], '(' .. int(now), '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
		if head[2] and (nextDue < 0 or tonumber(head[2]) - now < nextDue) then
			nextDue = tonumber(head[2]) - now
		end
	end
	if retry >= 0 and (nextDue < 0 or retry < nextDue) then nextDue = retry end
	return {jobs, stalled, invalid, nextDue, scheduled}
end
`;

/** The server's clock in ms, as `ADD` reads it, and in µs as `now_us` (the GCRA's), from one `TIME`. */
export const NOW_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local now_us = tonumber(time[1]) * 1000000 + tonumber(time[2])
`;

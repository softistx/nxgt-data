import { GCRA_FN } from '../../../rate-limit/gcra';
import { GROUP_FN } from '../groups/groups';
import { SCHEDULE_FIELDS, SCHEDULE_SOUND_FN } from '../schedule/schedule';
import { CLAIM_STEPS_FN } from './steps';
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
 * `local prefix` (the job-key prefix, inside the queue's slot) first, then
 * the locals `GROUP_FN` asks for (see `groupLocals`).
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake (a script may
 * be given more keys after these, as {@link scriptKeys} appends `events`,
 * `paused` (KEYS[9]), `rate` (KEYS[10], the queue-wide GCRA state),
 * `schedules` (KEYS[11]), `groupsReady` (KEYS[12]) and `groupsQueued`
 * (KEYS[13])).
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
 *    exists (1 and 2 still run, so `counts` stays honest) it pops nothing.
 *    On a grouped queue it pops round-robin instead (`pop_groups`), each
 *    group's best job, within the per-group concurrency;
 * 4. leaves one `wake` token when work is claimable (none if one is
 *    there), so a blocked peer takes over; deletes `wake` when there is none,
 *    and also while paused or rate-limited: a token there would make every
 *    worker spin on claims that pop nothing. Claimable is `ready` holding
 *    jobs, or on a grouped queue `groups:ready` holding a group, so ready
 *    jobs that all sit in full groups leave no token;
 * 5. gives the ms until the first `delayed` score, `-1` when it is empty,
 *    5000 while paused (the worker's own cap: it only has to notice a lost
 *    resume token), and, while the rate refuses the jobs in `ready`, the
 *    GCRA's `retryAfter` for one job when that is sooner;
 * 6. reports up to 20 sound schedules due now (the first 100 scored at or
 *    below `now`, earliest first, are read, so an unsound hash does not hide
 *    a sound one) as `{id, kind, spec, timezone, due}`, paused or not:
 *    schedules fire while paused. The claim fires nothing: the client
 *    computes each `next` and calls `FIRE`. A hash that fails
 *    `schedule_sound` is left out and left alone. `next` is 0 only when 20
 *    were reported (a backlog drains at once); otherwise it is bounded by the
 *    first schedule not yet due, so a due one nobody fires cannot make
 *    workers spin.
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
${GROUP_FN}
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
	local g = group_of(key)
	redis.call('ZREM', KEYS[1], id)
	ready_rem(id, g)
	if redis.call('ZREM', KEYS[3], id) == 1 then slot_freed(g) end
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
-- The schedules due now: the first 20 sound ones of the first 100 due (an
-- unsound hash is skipped, never repaired, and does not hide a sound one),
-- each {id, kind, spec, timezone, due}.
local function due_schedules(sprefix, now)
	local out = {}
	local rows = redis.call('ZRANGEBYSCORE', KEYS[11], '-inf', int(now), 'LIMIT', 0, 100, 'WITHSCORES')
	for i = 1, #rows, 2 do
		local f = redis.call('HMGET', sprefix .. rows[i], ${SCHEDULE_FIELDS})
		if #out < 20 and schedule_sound(f) then
			out[#out + 1] = {rows[i], f[1], f[2], f[3] or '', tonumber(rows[i + 1])}
		end
	end
	return out
end
${CLAIM_STEPS_FN}
local function claim(n, lease, tokens, now, rate, sprefix)
	local jobs, invalid = {}, {}
	local scheduled = due_schedules(sprefix, now)
	local stalled = reclaim(now, invalid)
	promote(now, invalid)
	local paused = redis.call('EXISTS', KEYS[9]) == 1
	local admit = admitted(n, paused, rate)
	local function begin(id, g)
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			local token = tokens[#jobs + 1]
			local attempt = tonumber(f[2]) + 1
			redis.call('HSET', key, 'state', 'active', 'token', token, 'attempt', attempt)
			redis.call('ZADD', KEYS[3], int(now + lease), id)
			slot_taken(g)
			jobs[#jobs + 1] = {id, f[1], attempt, tonumber(f[3]), token, f[5] and tonumber(f[5]) or -1}
		end
	end
	if admit > 0 and GROUPED then
		pop_groups(admit, begin)
	elseif admit > 0 then
		local popped = redis.call('ZPOPMIN', KEYS[2], admit)
		for i = 1, #popped, 2 do begin(popped[i], '') end
	end
	if rate and #jobs > 0 then
		gcra(KEYS[10], rate.us, rate.per, rate.limit, rate.burst, #jobs, true)
	end
	-- Jobs wait in ready that the rate refuses: no token, so no worker spins.
	local ready = redis.call('ZCARD', KEYS[2]) > 0
	if GROUPED then ready = redis.call('LLEN', GREADY) > 0 end
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
	return {jobs, stalled, invalid, next_wait(now, #scheduled >= 20, retry), scheduled}
end
`;

/** The server's clock in ms, as `ADD` reads it, and in µs as `now_us` (the GCRA's), from one `TIME`. */
export const NOW_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local now_us = tonumber(time[1]) * 1000000 + tonumber(time[2])
`;

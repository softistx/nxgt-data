import { defineScript } from '../../scripts/run-script';
import { WAKE_FN } from './wake';

/*
 * One hash per job, `queue:{<name>}:job:<id>`, written here with exactly
 * `data` (JSON, already parsed by the schema on the client), `priority`,
 * `attempt` (0), `attempts`, `state` (`waiting` or `delayed`), `added` and
 * `runAt` (ms, the server's clock), plus `timeout` (ms) when the job has
 * one. Later scripts add fields; none of them
 * is this script's to read, except that a debounce reads `state` and
 * `priority` of the job its key names, to know whether it still waits. The job id is in `delayed` (a future `runAt`) or
 * in `ready`, scored `priority * 2^40 + INCR(seq)`.
 *
 * This script never parses `data`: the client has checked it, and a script
 * that read it would trust what it did not write.
 */

/**
 * Adds up to 500 jobs, in order, and says for each whether it was new.
 *
 * An id that already has a hash is left alone, even when an earlier job of
 * this very call wrote it. A job due now goes to `ready`; a future one to
 * `delayed`. Either leaves a `wake` token when none is there (see
 * `WAKE_FN`), a delayed one only when it becomes the head of `delayed`: a
 * blocked worker's wait is sized to the old head.
 *
 * The score is formatted with `%d`, not concatenated: Lua numbers are
 * doubles, exact below 2^53, and a bare tostring would turn a large one into
 * exponent notation, which ZADD would still read but a reader of the key
 * would not expect.
 *
 * A job may carry a dedupe key, `<dedupe prefix><key>` holding a job id:
 *
 * - `throttle` (`mode` `t`): when the key exists the job is not added and the
 *   reply is the id it holds, even if that job is long gone; otherwise the
 *   job is added and the key set to its id with `PX ttlMs` (the window).
 * - `debounce` (`mode` `d`, `delayMs` the wait): when the key names a job
 *   whose hash says `waiting` (and it is in `ready`) or `delayed` (and it is
 *   in `delayed`), that job's `data` is replaced and it moves to `delayed` at
 *   now + wait, keeping its priority, attempts and timeout; the key's PX is
 *   refreshed and the reply is its id. While the key lives the job's state
 *   decides, not the TTL, which is `wait` plus a day: a memory bound, so a job
 *   left waiting longer can be joined by a second one. Any other state, a missing hash, or a
 *   hash of a shape this script could not have written (it is left alone)
 *   adds a new job and points the key at it. A run under way is never touched.
 *
 * KEYS: delayed, ready, seq, wake.
 * ARGV: job-key prefix, dedupe-key prefix, then per job `id, data, priority,
 * attempts, delayMs, atMs, timeoutMs, mode, dedupeKey, ttlMs` — `atMs` is -1
 * when the job has no `at`, and a past one is due now; `timeoutMs` is -1 when
 * the job has no limit, and the field is then left out; `mode` is `''`, `d`
 * or `t`.
 * Returns per job 0 (added), 1 (the id existed) or the id of the job the
 * dedupe key holds.
 */
export const ADD = defineScript(`
${WAKE_FN}
local prefix, dprefix = ARGV[1], ARGV[2]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
-- Whether a stored key value is an id this script could have written.
local function is_id(held)
	return #held >= 1 and #held <= 256 and not string.find(held, '[{}]')
end
-- The job a debounce key names, when it is still waiting; nil otherwise.
local function waiting_job(held)
	local f = redis.call('HMGET', prefix .. held, 'state', 'priority')
	if tonumber(f[2]) == nil then return nil end
	if f[1] == 'waiting' and redis.call('ZSCORE', KEYS[2], held) then return held end
	if f[1] == 'delayed' and redis.call('ZSCORE', KEYS[1], held) then return held end
	return nil
end
local out = {}
for i = 3, #ARGV, 10 do
	local id, data, priority, attempts = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
	local delay, at, timeout = tonumber(ARGV[i + 4]), tonumber(ARGV[i + 5]), tonumber(ARGV[i + 6])
	local mode, dkey, ttl = ARGV[i + 7], ARGV[i + 8], ARGV[i + 9]
	local key = prefix .. id
	local held = false
	if mode ~= '' then held = redis.call('GET', dprefix .. dkey) end
	if held and not is_id(held) then held = false end
	local hit = nil
	if held and mode == 't' then hit = held end
	if held and mode == 'd' then hit = waiting_job(held) end
	if hit and mode == 'd' then
		local runAt = now + delay
		redis.call('HSET', prefix .. hit, 'data', data, 'state', 'delayed', 'runAt', runAt)
		redis.call('ZREM', KEYS[2], hit)
		if is_head(KEYS[1], runAt) then wake(KEYS[4]) end
		redis.call('ZADD', KEYS[1], string.format('%d', runAt), hit)
		redis.call('SET', dprefix .. dkey, hit, 'PX', ttl)
		out[#out + 1] = hit
	elseif hit then
		out[#out + 1] = hit
	elseif redis.call('EXISTS', key) == 1 then
		out[#out + 1] = 1
	else
		local runAt = now + delay
		if at >= 0 then runAt = at end
		local due = runAt <= now
		if due then runAt = now end
		redis.call('HSET', key, 'data', data, 'priority', priority, 'attempt', 0,
			'attempts', attempts, 'state', due and 'waiting' or 'delayed',
			'added', now, 'runAt', runAt)
		if timeout >= 0 then redis.call('HSET', key, 'timeout', string.format('%d', timeout)) end
		if due then
			local score = tonumber(priority) * 1099511627776 + redis.call('INCR', KEYS[3])
			redis.call('ZADD', KEYS[2], string.format('%d', score), id)
			wake(KEYS[4])
		else
			if is_head(KEYS[1], runAt) then wake(KEYS[4]) end
			redis.call('ZADD', KEYS[1], string.format('%d', runAt), id)
		end
		if mode ~= '' then redis.call('SET', dprefix .. dkey, id, 'PX', ttl) end
		out[#out + 1] = 0
	end
end
return out
`);

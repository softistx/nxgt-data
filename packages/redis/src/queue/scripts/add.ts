import { defineScript } from '../../scripts/run-script';
import { WAKE_FN } from './wake';

/*
 * One hash per job, `queue:{<name>}:job:<id>`, written here with exactly
 * `data` (JSON, already parsed by the schema on the client), `priority`,
 * `attempt` (0), `attempts`, `state` (`waiting` or `delayed`), `added` and
 * `runAt` (ms, the server's clock), plus `timeout` (ms) when the job has
 * one. Later scripts add fields; none of them
 * is this script's to read. The job id is in `delayed` (a future `runAt`) or
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
 * KEYS: delayed, ready, seq, wake.
 * ARGV: job-key prefix, then per job `id, data, priority, attempts, delayMs,
 * atMs, timeoutMs` — `atMs` is -1 when the job has no `at`, and a past one is
 * due now; `timeoutMs` is -1 when the job has no limit, and the field is
 * then left out.
 * Returns per job 0 (added) or 1 (the id existed).
 */
export const ADD = defineScript(`
${WAKE_FN}
local prefix = ARGV[1]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local out = {}
for i = 2, #ARGV, 7 do
	local id, data, priority, attempts = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
	local delay, at, timeout = tonumber(ARGV[i + 4]), tonumber(ARGV[i + 5]), tonumber(ARGV[i + 6])
	local key = prefix .. id
	if redis.call('EXISTS', key) == 1 then
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
		out[#out + 1] = 0
	end
end
return out
`);

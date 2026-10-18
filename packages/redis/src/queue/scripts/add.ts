import { defineScript } from '../../scripts/run-script';

/*
 * One hash per job, `queue:{<name>}:job:<id>`, written here with exactly
 * `data` (JSON, already parsed by the schema on the client), `priority`,
 * `attempt` (0), `attempts`, `state` (`waiting` or `delayed`), `added` and
 * `runAt` (ms, the server's clock). Later scripts add fields; none of them
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
 * this very call wrote it. A job due now goes to `ready`, with one `wake`
 * token; a future one to `delayed`, with none (a worker's wait is sized to
 * it). `wake` is trimmed once, at the end.
 *
 * The score is formatted with `%d`, not concatenated: Lua numbers are
 * doubles, exact below 2^53, and a bare tostring would turn a large one into
 * exponent notation, which ZADD would still read but a reader of the key
 * would not expect.
 *
 * KEYS: delayed, ready, seq, wake.
 * ARGV: job-key prefix, then per job `id, data, priority, attempts, delayMs,
 * atMs` — `atMs` is -1 when the job has no `at`, and a past one is due now.
 * Returns per job 0 (added) or 1 (the id existed).
 */
export const ADD = defineScript(`
local prefix = ARGV[1]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local out = {}
local pushed = 0
for i = 2, #ARGV, 6 do
	local id, data, priority, attempts = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
	local delay, at = tonumber(ARGV[i + 4]), tonumber(ARGV[i + 5])
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
		if due then
			local score = tonumber(priority) * 1099511627776 + redis.call('INCR', KEYS[3])
			redis.call('ZADD', KEYS[2], string.format('%d', score), id)
			redis.call('LPUSH', KEYS[4], 1)
			pushed = pushed + 1
		else
			redis.call('ZADD', KEYS[1], string.format('%d', runAt), id)
		end
		out[#out + 1] = 0
	end
end
if pushed > 0 then redis.call('LTRIM', KEYS[4], 0, 999) end
return out
`);

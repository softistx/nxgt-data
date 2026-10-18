import { defineScript } from '../../scripts/run-script';
import { CLAIM_FN, NOW_LUA } from './claim';

/*
 * The scripts of inspection and repair. `RETRY` and `REMOVE` act on one job
 * and decide by the job's place — the sorted set it is in — and its stored
 * `state` together, so a hash that disagrees with its set is left alone
 * rather than repaired (the trust rule of `claim.ts`).
 */

/**
 * How many jobs are in each state, from the five sets' cardinalities: one
 * script, so the numbers are of one instant, not five moments of a busy queue.
 *
 * KEYS: delayed, ready, active, completed, failed.
 * Returns `{waiting, delayed, active, completed, failed}` as five numbers.
 */
export const COUNTS = defineScript(`
return {
	redis.call('ZCARD', KEYS[2]),
	redis.call('ZCARD', KEYS[1]),
	redis.call('ZCARD', KEYS[3]),
	redis.call('ZCARD', KEYS[4]),
	redis.call('ZCARD', KEYS[5]),
}
`);

/**
 * Puts a failed job back in `ready`: `state=waiting`, `attempt=0`, `runAt`
 * now, the `error` and `finished` of the last run removed, a fresh ready
 * score from its stored priority, and a `wake` token when none is there.
 * It takes {@link CLAIM_FN} only for its shared helpers (`sound`,
 * `ready_score`, `wake`), so the score and the wake rule have one body.
 *
 * Only a job that is in `failed`, whose `state` says so and whose hash is
 * one this package could have written is retried; anything else changes
 * nothing.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake.
 * ARGV: job-key prefix, id.
 * Returns 1 (retried) or 0 (not retryable, nothing changed).
 */
export const RETRY = defineScript(`
local prefix = ARGV[1]
${CLAIM_FN}
${NOW_LUA}
local id = ARGV[2]
local key = prefix .. id
if not redis.call('ZSCORE', KEYS[5], id) then return 0 end
if redis.call('HGET', key, 'state') ~= 'failed' then return 0 end
local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority')
if not sound(f) then return 0 end
redis.call('ZREM', KEYS[5], id)
redis.call('HSET', key, 'state', 'waiting', 'attempt', 0, 'runAt', int(now))
redis.call('HDEL', key, 'error', 'finished', 'token')
redis.call('ZADD', KEYS[2], ready_score(f[4]), id)
wake(KEYS[7])
return 1
`);

/**
 * Deletes a job that is not running, from whichever set holds it, with its
 * hash. An active job is refused: its worker holds it, and deleting it would
 * only make that worker's settle a no-op while the work still ran.
 *
 * KEYS: delayed, ready, active, completed, failed.
 * ARGV: job-key prefix, id.
 * Returns 1 (removed), 0 (no such job) or 2 (active, nothing changed). An id
 * left in a set with no hash is dropped from it and answers 0.
 */
export const REMOVE = defineScript(`
local id = ARGV[2]
local key = ARGV[1] .. id
if redis.call('ZSCORE', KEYS[3], id) or redis.call('HGET', key, 'state') == 'active' then
	return 2
end
local existed = redis.call('EXISTS', key)
for i = 1, 5 do redis.call('ZREM', KEYS[i], id) end
redis.call('DEL', key)
return existed
`);

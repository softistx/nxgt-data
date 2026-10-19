import { defineScript } from '../../scripts/run-script';
import { CLAIM_FN, NOW_LUA } from './claim-body';
import { GROUP_FN, groupLocals } from './groups';
import { WAKE_FN } from './wake';

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
 * KEYS: delayed, ready, active, completed, failed, paused.
 * Returns `{waiting, delayed, active, completed, failed, paused}` as six
 * numbers, `paused` being 1 or 0.
 */
export const COUNTS = defineScript(`
return {
	redis.call('ZCARD', KEYS[2]),
	redis.call('ZCARD', KEYS[1]),
	redis.call('ZCARD', KEYS[3]),
	redis.call('ZCARD', KEYS[4]),
	redis.call('ZCARD', KEYS[5]),
	redis.call('EXISTS', KEYS[6]),
}
`);

/**
 * Pauses a queue: sets `paused`, so claims pop nothing. Idempotent.
 *
 * KEYS: paused.
 */
export const PAUSE = defineScript(`
redis.call('SET', KEYS[1], 1)
return 1
`);

/**
 * Resumes a queue: deletes `paused`, and leaves one `wake` token when
 * `ready` holds jobs or `delayed` is not empty, so a blocked worker starts
 * at once (passing the baton, or sizing its wait to the delayed job that
 * fell due during the pause). Idempotent.
 *
 * KEYS: paused, ready, wake, delayed.
 */
export const RESUME = defineScript(`
${WAKE_FN}
redis.call('DEL', KEYS[1])
if redis.call('ZCARD', KEYS[2]) > 0 or redis.call('ZCARD', KEYS[4]) > 0 then wake(KEYS[3]) end
return 1
`);

/**
 * Puts a failed job back in `ready`: `state=waiting`, `attempt=0`, `runAt`
 * now, the `error` and `finished` of the last run removed, a fresh ready
 * score from its stored priority, and a `wake` token when none is there and
 * the queue is not paused (`RESUME` leaves one).
 * It takes {@link CLAIM_FN} only for its shared helpers (`sound`,
 * `ready_score`, `wake`), so the score and the wake rule have one body.
 *
 * With `ARGV[3]` at `'1'` (a fresh retry) it also deletes every hash field
 * named `step:*`, in the same script and only once the retry is certain, so
 * the handler's steps all run again. `data`, `priority` and the rest stay.
 *
 * It also writes `retried` (`1`), which stays on the hash: `ADD`'s debounce
 * refuses to join a job that has it, since `attempt` is back to 0 though the
 * job has run. No other script reads it, and `sound()` ignores fields it does
 * not name.
 *
 * Only a job that is in `failed`, whose `state` says so and whose hash is
 * one this package could have written is retried; anything else changes
 * nothing.
 *
 * On a grouped queue the job joins its group's zset and queues the group
 * through `ready_add`, and the wake token follows only when it is claimable.
 *
 * KEYS: those of `scriptKeys` (it reads the first seven, `paused` and the
 * groups' three).
 * ARGV: job-key prefix, id, fresh (`'1'` or `'0'`), the three group
 * arguments (see `groupArgs`); the marker check of `groupModeCheck` runs first.
 * Returns 1 (retried) or 0 (not retryable, nothing changed).
 */
export const RETRY = defineScript(`
local prefix = ARGV[1]${groupLocals(4)}
${CLAIM_FN}
${NOW_LUA}
local id = ARGV[2]
local key = prefix .. id
if not redis.call('ZSCORE', KEYS[5], id) then return 0 end
if redis.call('HGET', key, 'state') ~= 'failed' then return 0 end
local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority')
if not sound(f) then return 0 end
redis.call('ZREM', KEYS[5], id)
redis.call('HSET', key, 'state', 'waiting', 'attempt', 0, 'retried', 1, 'runAt', int(now))
redis.call('HDEL', key, 'error', 'finished', 'token')
local claimable = ready_add(id, ready_score(f[4]), group_of(key))
if ARGV[3] == '1' then
	for _, name in ipairs(redis.call('HKEYS', key)) do
		if string.sub(name, 1, 5) == 'step:' then redis.call('HDEL', key, name) end
	end
end
if claimable and redis.call('EXISTS', KEYS[9]) == 0 then wake(KEYS[7]) end
return 1
`);

/**
 * Deletes a job that is not running, from whichever set holds it, with its
 * hash. An active job is refused: its worker holds it, and deleting it would
 * only make that worker's settle a no-op while the work still ran.
 *
 * A waiting job also leaves its group's zset on a grouped queue (`ready_rem`).
 *
 * KEYS: those of `scriptKeys`; it reads the first five and the groups' three.
 * ARGV: job-key prefix, id, the three group arguments (see `groupArgs`); the
 * marker check of `groupModeCheck` runs first.
 * Returns 1 (removed), 0 (no such job) or 2 (active, nothing changed). An id
 * left in a set with no hash is dropped from it and answers 0.
 */
export const REMOVE = defineScript(`
${groupLocals(3)}
${GROUP_FN}
local id = ARGV[2]
local key = ARGV[1] .. id
if redis.call('ZSCORE', KEYS[3], id) or redis.call('HGET', key, 'state') == 'active' then
	return 2
end
local existed = redis.call('EXISTS', key)
ready_rem(id, group_of(key))
for i = 1, 5 do
	if i ~= 2 then redis.call('ZREM', KEYS[i], id) end
end
redis.call('DEL', key)
return existed
`);

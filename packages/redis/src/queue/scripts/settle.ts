import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import type { QueueDefinition } from '../types';
import { groupArgs, newToken, rateArgs, scriptKeys } from './claim';
import { CLAIM_FN, NOW_LUA } from './claim-body';
import { groupLocals } from './groups';
import { type ClaimReply, parseComplete, parseFail } from './replies';

/*
 * Settling trusts the token alone: the job is the caller's only while the
 * hash still holds the token it was given. A mismatch changes nothing and
 * answers `settled = 0` (the lease lapsed and another worker may hold the
 * job). `attempt` and `attempts` are read for the retry decision with a
 * numeric guard, so a hash this package could not have written fails for
 * good rather than retries.
 */

/**
 * Drops what a retention rule no longer keeps from `zkey`: first the ids
 * older than `age` ms, then the oldest beyond `count` (`-1` for no count),
 * deleting their hashes. At most 100 removals per call, so a backlog is
 * trimmed over many settles and none is slowed by it.
 */
const TRIM_FN = `
local function trim(zkey, now, age, count)
	local left = 100
	local function drop(ids)
		for _, id in ipairs(ids) do
			redis.call('DEL', prefix .. id)
			redis.call('ZREM', zkey, id)
		end
		left = left - #ids
	end
	drop(redis.call('ZRANGEBYSCORE', zkey, '-inf', '(' .. string.format('%d', now - age), 'LIMIT', 0, left))
	if count >= 0 and left > 0 then
		local excess = redis.call('ZCARD', zkey) - count
		if excess > 0 then
			drop(redis.call('ZRANGE', zkey, 0, math.min(excess, left) - 1))
		end
	end
end
`;

/**
 * Completes a job if its token still holds: `state=completed`, `finished`,
 * the token removed, out of `active` into `completed` (scored by `now`),
 * then `completed` is trimmed by age, then count. A `keepAge` of `-1`
 * (`keepCompleted: false`) deletes the hash at once. A `result` is stored in
 * the hash as given (JSON); the outcome, with the result, is published on
 * `events` once settled, so `finished()` gets it even when nothing is kept. A
 * stale token publishes nothing. With a claim token it then runs
 * {@link CLAIM_FN} for one job, so a busy worker spends one script per job.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake, events,
 * paused, rate, schedules, groupsReady, groupsQueued.
 * ARGV: job-key prefix, id, token, keepAge (ms, -1 to keep nothing),
 * keepCount, lease (ms), claim token (`''` for no claim), result (JSON,
 * `''` for none), then the rate's `per`, `limit` and `burst` (`0 0 0` for
 * none), the schedule-key prefix and the three group arguments (see
 * `groupArgs`). Returns `{settled, jobs, stalled, invalid, next, due}`.
 */
export const COMPLETE = defineScript(`
local prefix = ARGV[1]${groupLocals(13)}
${CLAIM_FN}
${TRIM_FN}
${NOW_LUA}
local id, token = ARGV[2], ARGV[3]
local key = prefix .. id
local settled, freed = 0, false
if redis.call('HGET', key, 'token') == token then
	settled = 1
	local g = group_of(key)
	if redis.call('ZREM', KEYS[3], id) == 1 then freed = slot_freed(g) end
	local keepAge = tonumber(ARGV[4])
	if keepAge < 0 then
		-- keepCompleted: false. Older entries of a definition that kept some
		-- are dropped too, so switching it off does not leak them.
		redis.call('DEL', key)
		trim(KEYS[4], now, 0, 0)
	else
		redis.call('HSET', key, 'state', 'completed', 'finished', string.format('%d', now))
		if ARGV[8] ~= '' then redis.call('HSET', key, 'result', ARGV[8]) end
		redis.call('HDEL', key, 'token')
		redis.call('ZADD', KEYS[4], string.format('%d', now), id)
		trim(KEYS[4], now, keepAge, tonumber(ARGV[5]))
	end
	publish(KEYS[8], 'completed', id, 'result', ARGV[8])
end
-- The claim depends on the worker's free slot, not on the settle taking.
local out = {settled, {}, {}, {}, -1, {}}
if ARGV[7] ~= '' then
	local claimed = claim(1, tonumber(ARGV[6]), {ARGV[7]}, now, rate_of(9, now_us), ARGV[12])
	out = {settled, claimed[1], claimed[2], claimed[3], claimed[4], claimed[5]}
elseif freed and redis.call('EXISTS', KEYS[9]) == 0 then
	wake(KEYS[7])
end
return out
`);

/**
 * Fails a job if its token still holds. With a retry delay (`retryIn` >= 0)
 * and attempts left (`attempt < attempts`) it goes to `delayed` at
 * `now + retryIn` with the error kept; otherwise to `failed`, scored `now`,
 * and `failed` is trimmed by age, and the failure is published on `events`
 * (`{type: 'failed', id, error}`). A retry and a stale token publish nothing.
 * Claims the next job as `COMPLETE` does.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake, events,
 * paused, rate, schedules, groupsReady, groupsQueued.
 * ARGV: job-key prefix, id, token, error (JSON `{name, message}`), retryIn
 * (ms, -1 for no retry), keepFailed age (ms), lease (ms), claim token (`''`
 * for no claim), then the rate's `per`, `limit` and `burst` (`0 0 0` for
 * none), the schedule-key prefix and the three group arguments (see
 * `groupArgs`). Returns `{settled, final, jobs, stalled, invalid, next, due}`.
 */
export const FAIL = defineScript(`
local prefix = ARGV[1]${groupLocals(13)}
${CLAIM_FN}
${TRIM_FN}
${NOW_LUA}
local id, token = ARGV[2], ARGV[3]
local key = prefix .. id
local settled, final, freed = 0, 0, false
local headWake = false
if redis.call('HGET', key, 'token') == token then
	settled, final = 1, 1
	local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority')
	local retryIn = tonumber(ARGV[5])
	if redis.call('ZREM', KEYS[3], id) == 1 then freed = slot_freed(group_of(key)) end
	redis.call('HDEL', key, 'token')
	if retryIn >= 0 and sound(f) and tonumber(f[2]) < tonumber(f[3]) then
		final = 0
		local at = string.format('%d', now + retryIn)
		headWake = is_head(KEYS[1], now + retryIn)
		redis.call('HSET', key, 'state', 'delayed', 'error', ARGV[4], 'runAt', at)
		redis.call('ZADD', KEYS[1], at, id)
	else
		redis.call('HSET', key, 'state', 'failed', 'error', ARGV[4], 'finished', string.format('%d', now))
		redis.call('ZADD', KEYS[5], string.format('%d', now), id)
		trim(KEYS[5], now, tonumber(ARGV[6]), -1)
		publish(KEYS[8], 'failed', id, 'error', ARGV[4])
	end
end
local out = {settled, final, {}, {}, {}, -1, {}}
if ARGV[8] ~= '' then
	local claimed = claim(1, tonumber(ARGV[7]), {ARGV[8]}, now, rate_of(9, now_us), ARGV[12])
	out = {settled, final, claimed[1], claimed[2], claimed[3], claimed[4], claimed[5]}
elseif freed and redis.call('EXISTS', KEYS[9]) == 0 then
	wake(KEYS[7])
end
-- After the claim, whose DEL of an empty \`ready\` would erase it: a retry that
-- became the head of delayed, and is still there, shortens a blocked wait.
if headWake and redis.call('ZSCORE', KEYS[1], id) then wake(KEYS[7]) end
return out
`);

/** What a settle needs of the definition. */
type Retention = Pick<
	QueueDefinition<never>,
	'lease' | 'keepCompleted' | 'keepFailed' | 'rateLimit' | 'groups'
>;

/**
 * Completes a job. `settled` is `false` when the token no longer holds: the
 * lease lapsed, and nothing was changed. `result` is the handler's return as
 * JSON, or `undefined` for none: it is stored with the job and published with
 * the outcome. With `claimNext`, the same script claims one more job,
 * returned in `jobs`.
 */
export async function complete(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	definition: Retention,
	id: string,
	token: string,
	result: string | undefined,
	claimNext: boolean,
): Promise<ClaimReply & { settled: boolean }> {
	const keep = definition.keepCompleted;
	return parseComplete(
		await runScript(client, COMPLETE, scriptKeys(keys), [
			keys.prefix,
			id,
			token,
			keep === false ? -1 : keep.age,
			keep === false ? -1 : keep.count,
			definition.lease,
			claimNext ? newToken() : '',
			result ?? '',
			...rateArgs(definition.rateLimit),
			keys.schedule,
			...groupArgs(keys, definition.groups),
		]),
	);
}

/**
 * Fails a job: to a retry in `retryInMs`, or for good when `retryInMs` is
 * `null` or the attempts are spent (`final`). `settled` is `false` when the
 * token no longer holds. With `claimNext`, the same script claims one more.
 */
export async function fail(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	definition: Retention,
	id: string,
	token: string,
	error: { name: string; message: string },
	retryInMs: number | null,
	claimNext: boolean,
): Promise<ClaimReply & { settled: boolean; final: boolean }> {
	return parseFail(
		await runScript(client, FAIL, scriptKeys(keys), [
			keys.prefix,
			id,
			token,
			JSON.stringify({ name: error.name, message: error.message }),
			retryInMs ?? -1,
			definition.keepFailed,
			definition.lease,
			claimNext ? newToken() : '',
			...rateArgs(definition.rateLimit),
			keys.schedule,
			...groupArgs(keys, definition.groups),
		]),
	);
}

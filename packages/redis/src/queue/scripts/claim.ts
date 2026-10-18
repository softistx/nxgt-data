import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import { type ClaimReply, parseClaimReply } from './replies';
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
 * The claim step, one Lua function, concatenated into `CLAIM`, `COMPLETE`
 * and `FAIL` so a single body exists. The including script defines
 * `local prefix` (the job-key prefix, inside the queue's slot) first.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake (a script may
 * be given more keys after these, as {@link scriptKeys} appends `events`).
 * `claim(n, lease, tokens, now)` takes a table of at least `n` tokens, one
 * per slot, and returns `{jobs, stalled, invalid, next}`, each job being
 * `{id, data, attempt, attempts, token, timeout}` (`timeout` in ms, `-1` for
 * none):
 *
 * 1. reclaims up to 100 `active` ids whose score is below `now`. The attempt
 *    was counted when the lease began, so a job that kills its process does
 *    not loop forever: with attempts left it goes back to `ready` with the
 *    score rebuilt from its stored `priority` and a fresh `INCR seq`,
 *    otherwise to `failed` as `LeaseLapsed`;
 * 2. promotes up to 1000 due `delayed` ids to `ready`;
 * 3. pops up to `n` from `ready`, marking each `active` with its token,
 *    `attempt + 1` and a lease ending at `now + lease`;
 * 4. leaves one `wake` token when `ready` still holds jobs (none if one is
 *    there), so a blocked peer takes over; deletes `wake` when it is empty;
 * 5. gives the ms until the first `delayed` score, `-1` when it is empty.
 */
export const CLAIM_FN = `
${WAKE_FN}
local function int(x) return string.format('%d', x) end
-- tonumber alone would accept 'inf', 'nan', '1e3', '0x10', '-4' and '1.5':
-- an attempts of 'inf' would reclaim a crash-looping job forever, and a
-- priority of 5000 or 'inf' has no ready score, and a timeout of 'inf' would
-- never fire. This package writes whole decimal numbers only, so only those
-- are trusted.
local function whole(v) return v and string.match(v, '^%d+$') ~= nil end
local function sound(f)
	return f[1] and whole(f[2]) and whole(f[3]) and whole(f[4])
		and tonumber(f[3]) >= 1 and tonumber(f[4]) <= 1000
		and (not f[5] or (whole(f[5]) and tonumber(f[5]) >= 1))
end
local function ready_score(priority)
	return int(tonumber(priority) * 1099511627776 + redis.call('INCR', KEYS[6]))
end
-- An id whose hash is gone is only dropped; a hash this package could not
-- have written goes to failed, once, and is reported.
local function refuse(id, now, invalid)
	local key = prefix .. id
	redis.call('ZREM', KEYS[1], id)
	redis.call('ZREM', KEYS[2], id)
	redis.call('ZREM', KEYS[3], id)
	if redis.call('EXISTS', key) == 0 then return end
	redis.call('HSET', key, 'state', 'failed', 'error',
		'{"name":"QueueError","message":"INVALID: a stored job this package could not have written"}',
		'finished', int(now))
	redis.call('HDEL', key, 'token')
	redis.call('ZADD', KEYS[5], int(now), id)
	invalid[#invalid + 1] = id
end
local function claim(n, lease, tokens, now)
	local jobs, stalled, invalid = {}, {}, {}
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
				redis.call('HSET', key, 'state', 'failed', 'error',
					'{"name":"LeaseLapsed","message":"lease lapsed"}', 'finished', int(now))
				redis.call('ZADD', KEYS[5], int(now), id)
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
	local popped = redis.call('ZPOPMIN', KEYS[2], n)
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
	if redis.call('ZCARD', KEYS[2]) > 0 then
		wake(KEYS[7])
	else
		redis.call('DEL', KEYS[7])
	end
	local nextDue = -1
	local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
	if first[2] then nextDue = math.max(0, tonumber(first[2]) - now) end
	return {jobs, stalled, invalid, nextDue}
end
`;

/** The server's clock in ms, as `ADD` reads it. */
export const NOW_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
`;

/**
 * Takes up to `n` jobs: reclaims, promotes and pops as {@link CLAIM_FN} says.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake, events.
 * ARGV: job-key prefix, n, lease (ms), then `n` tokens.
 * Returns `{jobs, stalled, invalid, next}`.
 */
export const CLAIM = defineScript(`
local prefix = ARGV[1]
${CLAIM_FN}
${NOW_LUA}
local tokens = {}
for i = 4, #ARGV do tokens[#tokens + 1] = ARGV[i] end
return claim(tonumber(ARGV[2]), tonumber(ARGV[3]), tokens, now)
`);

/**
 * The keys of one queue, as a script takes them: `CLAIM_FN`'s seven, then
 * `events`, which only the scripts that publish read.
 */
export function scriptKeys(keys: ReturnType<typeof queueKeys>): string[] {
	return [
		keys.delayed,
		keys.ready,
		keys.active,
		keys.completed,
		keys.failed,
		keys.seq,
		keys.wake,
		keys.events,
	];
}

/** A claim's token: 128 random bits, as 32 lowercase hex characters. */
export function newToken(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/**
 * Claims up to `n` jobs in one script, each under a fresh token.
 *
 * @param lease - ms the lease lasts, from the server's clock.
 */
export async function claim(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	n: number,
	lease: number,
): Promise<ClaimReply> {
	const tokens = Array.from({ length: n }, newToken);
	return parseClaimReply(
		await runScript(client, CLAIM, scriptKeys(keys), [
			keys.prefix,
			n,
			lease,
			...tokens,
		]),
	);
}

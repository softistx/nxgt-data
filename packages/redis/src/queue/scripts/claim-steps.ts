/**
 * The claim's reclaim, promote and wait steps, as Lua functions, split out of
 * `CLAIM_FN` (which concatenates them, after the helpers they use: `int`,
 * `sound`, `ready_score`, `refuse`, `publish`, `GROUP_FN`'s helpers, and the
 * including script's `prefix`) to keep that body under the size limits. The keys are the claim's
 * (see `CLAIM_FN`): `delayed` KEYS[1], `ready` KEYS[2], `active` KEYS[3],
 * `failed` KEYS[5], `events` KEYS[8], `schedules` KEYS[11].
 *
 * - `reclaim(now, invalid)` reclaims up to 100 `active` ids whose lease
 *   lapsed, and returns the reclaimed ids; a refused hash is added to `invalid`.
 * - `promote(now, invalid)` moves up to 1000 due `delayed` ids to `ready`; a
 *   refused hash is added to `invalid`.
 * - `next_wait(now, backlog, retry)` gives the ms a worker may wait.
 * - `pop_groups(n, begin)` serves a grouped queue round-robin: up to `n` times
 *   it takes the head of `groups:ready`, pops that group's best ready job and
 *   hands it to `begin(id, group)`, which starts it (and takes the slot).
 *   The group then goes to the tail when it still has jobs and a free slot. A
 *   group that is empty or full is dropped from the list, and the takes are
 *   capped at `2n + 10`, so stale entries cost one claim, never a loop.
 */
export const CLAIM_STEPS_FN = `
-- The ms a worker may wait: 0 for a full page of due schedules (a backlog
-- drains at once), else the sooner of the first delayed job, the first
-- schedule not yet due, and the rate's retry; -1 for nothing.
local function next_wait(now, backlog, retry)
	if backlog then return 0 end
	local wait = -1
	local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
	if first[2] then wait = math.max(0, tonumber(first[2]) - now) end
	local head = redis.call('ZRANGEBYSCORE', KEYS[11], '(' .. int(now), '+inf', 'LIMIT', 0, 1, 'WITHSCORES')
	if head[2] and (wait < 0 or tonumber(head[2]) - now < wait) then
		wait = tonumber(head[2]) - now
	end
	if retry >= 0 and (wait < 0 or retry < wait) then wait = retry end
	return wait
end
local function pop_groups(n, begin)
	local got, takes = 0, 0
	while got < n and takes < 2 * n + 10 do
		local g = rr_take()
		if g == nil then break end
		takes = takes + 1
		local popped = {}
		if has_slot(g) then popped = redis.call('ZPOPMIN', gkey(g, 'ready'), 1) end
		if popped[1] then
			got = got + 1
			redis.call('ZREM', READY, popped[1])
			begin(popped[1], g)
			if has_slot(g) and redis.call('ZCARD', gkey(g, 'ready')) > 0 then rr_push(g) end
		end
	end
end
local function reclaim(now, invalid)
	local stalled = {}
	local lapsed = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. int(now), 'LIMIT', 0, 100)
	for _, id in ipairs(lapsed) do
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout', 'group')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			if redis.call('ZREM', KEYS[3], id) == 1 then slot_freed(f[6] or '') end
			redis.call('HDEL', key, 'token')
			if tonumber(f[2]) < tonumber(f[3]) then
				redis.call('HSET', key, 'state', 'waiting')
				ready_add(id, ready_score(f[4]), f[6] or '')
			else
				redis.call('HSET', key, 'state', 'failed', 'error', LAPSED_ERROR, 'finished', int(now))
				redis.call('ZADD', KEYS[5], int(now), id)
				publish(KEYS[8], 'failed', id, 'error', LAPSED_ERROR)
			end
			stalled[#stalled + 1] = id
		end
	end
	return stalled
end
local function promote(now, invalid)
	local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', int(now), 'LIMIT', 0, 1000)
	for _, id in ipairs(due) do
		local key = prefix .. id
		local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout', 'group')
		if not sound(f) then
			refuse(id, now, invalid)
		else
			redis.call('ZREM', KEYS[1], id)
			redis.call('HSET', key, 'state', 'waiting')
			ready_add(id, ready_score(f[4]), f[6] or '')
		end
	end
end
`;

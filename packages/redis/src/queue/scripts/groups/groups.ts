/**
 * The groups' Lua, the one module that writes `ready`'s group mirror, the
 * active counters and the round-robin list, so the four invariants of a
 * grouped queue live in one place:
 *
 * 1. an id is in `ready` exactly when it is in `group:<g>:ready` (`g` the
 *    hash's `group`, or `''` for the default group);
 * 2. `group:<g>:active` counts the ids of `active` whose group is `g`; only
 *    named groups are counted, the default group has no cap and no counter;
 * 3. `g` is in the `groups:queued` set exactly when it is in the
 *    `groups:ready` list, once;
 * 4. a group with ready jobs and a free slot is in `groups:queued`.
 *
 * The including script defines, before it: `READY` (the key of `ready`),
 * `GREADY` (the list), `GQUEUED` (the set), `GROUPED` (a boolean: false makes
 * every helper a plain `ready` operation, writing no group key), `CONCURRENCY`
 * (a whole number, 0 for no cap) and `GPREFIX` (the key prefix of
 * `group:<g>:ready` and `group:<g>:active`, inside the queue's slot; a group
 * name has no `:`).
 *
 * - `group_of(key)` is the `group` field of a job hash, `''` when absent;
 * - `has_slot(g)` says whether `g` may start one more job;
 * - `ready_add(id, score, g)` and `ready_rem(id, g)` write `ready` and its
 *   mirror; `ready_add` queues a group with a free slot and answers whether
 *   the job is claimable now (always true on an ungrouped queue), so the
 *   caller leaves a wake token only then;
 * - `slot_taken(g)` counts a job that became active;
 * - `slot_freed(g)` runs exactly when `ZREM active` answered 1: it uncounts
 *   the job, queues the group when it has ready jobs and answers whether the
 *   group is claimable now, so the caller may leave a wake token;
 * - `rr_push(g)` appends `g` to the tail unless it is queued, and `rr_take()`
 *   pops the head (nil for none).
 */
export const GROUP_FN = `
local function gkey(g, part) return GPREFIX .. g .. ':' .. part end
local function group_of(key) return redis.call('HGET', key, 'group') or '' end
local function has_slot(g)
	if g == '' or CONCURRENCY == 0 then return true end
	return (tonumber(redis.call('GET', gkey(g, 'active'))) or 0) < CONCURRENCY
end
local function rr_push(g)
	if redis.call('SADD', GQUEUED, g) == 1 then redis.call('RPUSH', GREADY, g) end
end
local function rr_take()
	local g = redis.call('LPOP', GREADY)
	if not g then return nil end
	redis.call('SREM', GQUEUED, g)
	return g
end
local function ready_add(id, score, g)
	redis.call('ZADD', READY, score, id)
	if not GROUPED then return true end
	redis.call('ZADD', gkey(g, 'ready'), score, id)
	if not has_slot(g) then return false end
	rr_push(g)
	return true
end
local function ready_rem(id, g)
	redis.call('ZREM', READY, id)
	if GROUPED then redis.call('ZREM', gkey(g, 'ready'), id) end
end
local function slot_taken(g)
	if GROUPED and g ~= '' then redis.call('INCR', gkey(g, 'active')) end
end
local function slot_freed(g)
	if not GROUPED then return false end
	if g ~= '' then
		local held = tonumber(redis.call('GET', gkey(g, 'active'))) or 0
		if held > 1 then redis.call('DECR', gkey(g, 'active'))
		elseif held == 1 then redis.call('DEL', gkey(g, 'active')) end
	end
	if redis.call('ZCARD', gkey(g, 'ready')) == 0 or not has_slot(g) then return false end
	rr_push(g)
	return true
end
`;

/**
 * The locals a script that runs {@link GROUP_FN} over the claim's keys
 * defines, from its three group ARGVs (`grouped` as `'1'` or `'0'`,
 * `concurrency`, the group prefix) starting at `at`, and from `groupsReady`
 * and `groupsQueued` at KEYS[12] and KEYS[13] (see `scriptKeys`).
 */
export function groupLocals(at: number): string {
	return `
local READY, GREADY, GQUEUED = KEYS[2], KEYS[12], KEYS[13]
local GROUPED, CONCURRENCY, GPREFIX = ARGV[${at}] == '1', tonumber(ARGV[${at + 1}]), ARGV[${at + 2}]
${groupModeCheck(14, at)}`;
}

/**
 * The marker check every script that takes `grouped` runs first, before any
 * write: the queue's `groups:mode` key (at KEYS[`key`]) holds `'0'` for an
 * ungrouped queue and `'1:<concurrency>'` otherwise, from the script's own
 * `grouped` and `concurrency` ARGVs (starting at `at`). A missing key is set
 * to the script's mode, the same mode passes, a different one is refused with
 * the error reply `ERR groups mismatch` and nothing is written: processes that
 * disagree on `groups` would strand jobs, run one twice or leak a slot.
 */
export function groupModeCheck(key: number, at: number): string {
	return `local MODE = ARGV[${at}] == '1' and ('1:' .. ARGV[${at + 1}]) or '0'
local HELD = redis.call('GET', KEYS[${key}])
if HELD and HELD ~= MODE then return redis.error_reply('${MISMATCH}') end
if not HELD then redis.call('SET', KEYS[${key}], MODE) end`;
}

/** The error reply a script answers when the queue's groups mode differs. */
export const MISMATCH = 'ERR groups mismatch';

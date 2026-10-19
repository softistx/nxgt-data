import { defineScript } from '../../scripts/run-script';
import { ADD_JOB_FN } from './add';
import { WAKE_FN } from './wake';

/*
 * One zset, `schedules` (id to the ms of the next occurrence), and one hash
 * per schedule, `queue:{<name>}:schedule:<id>`, written here with exactly
 * `kind` (`cron` or `every`), `spec` (the cron text, or the interval in ms),
 * `timezone` (a cron's only), `data` (JSON, already parsed by the schema on
 * the client) and `origin` (`definition` or `runtime`).
 *
 * These scripts never parse a cron or a zone: the client computes every
 * `next` and passes it in. They trust a hash only when this package could
 * have written it ({@link SCHEDULE_SOUND_FN}); one that fails the check is
 * skipped, never repaired.
 */

/**
 * The trust check on a schedule hash, as Lua: `schedule_sound(f)` takes the
 * reply of `HMGET kind, spec, timezone, data, origin`. A hash is sound when
 * `kind`, `spec`, `data` and `origin` exist, `origin` is `definition` or
 * `runtime`, `kind` is `cron` or `every`, and an `every` has no `timezone`
 * and a `spec` of whole ms, at least 1000 and at most 15 digits.
 */
export const SCHEDULE_SOUND_FN = `
local function schedule_sound(f)
	if not (f[1] and f[2] and f[4] and f[5]) then return false end
	if f[5] ~= 'definition' and f[5] ~= 'runtime' then return false end
	if f[1] == 'cron' then return true end
	return f[1] == 'every' and not f[3] and string.match(f[2], '^%d+$') ~= nil
		and #f[2] <= 15 and tonumber(f[2]) >= 1000
end
`;

/** The `HMGET` fields {@link SCHEDULE_SOUND_FN} reads, in order. */
export const SCHEDULE_FIELDS = `'kind', 'spec', 'timezone', 'data', 'origin'`;

/** Replaces a schedule's hash whole, so no field of an older shape survives. */
const WRITE_FN = `
local function write(key, kind, spec, zone, data, origin)
	redis.call('DEL', key)
	redis.call('HSET', key, 'kind', kind, 'spec', spec, 'data', data, 'origin', origin)
	if kind == 'cron' then redis.call('HSET', key, 'timezone', zone) end
end
`;

/**
 * Stores or replaces a runtime schedule: the hash with `origin=runtime`, and
 * its next occurrence in `schedules`. An id whose stored `origin` is
 * `definition` is refused and left as it is.
 *
 * KEYS: schedules.
 * ARGV: schedule-key prefix, id, kind, spec, timezone (`''` for an `every`),
 * data (JSON), next (ms).
 * Returns 1 (stored) or `'definition'`.
 */
export const UPSERT = defineScript(`
${WRITE_FN}
local key = ARGV[1] .. ARGV[2]
if redis.call('HGET', key, 'origin') == 'definition' then return 'definition' end
write(key, ARGV[3], ARGV[4], ARGV[5], ARGV[6], 'runtime')
redis.call('ZADD', KEYS[1], string.format('%d', tonumber(ARGV[7])), ARGV[2])
return 1
`);

/**
 * Removes a schedule: its hash and its `schedules` entry. An id whose stored
 * `origin` is `definition` is refused and left as it is.
 *
 * KEYS: schedules.
 * ARGV: schedule-key prefix, id.
 * Returns 1 (removed), 0 (none) or `'definition'`.
 */
export const UNSCHEDULE = defineScript(`
local key = ARGV[1] .. ARGV[2]
if redis.call('HGET', key, 'origin') == 'definition' then return 'definition' end
local had = redis.call('DEL', key) + redis.call('ZREM', KEYS[1], ARGV[2])
if had > 0 then return 1 end
return 0
`);

/**
 * Fires one due occurrence: when `schedules` still scores the id at `due`
 * (so a second caller, or a stale one, finds nothing to do) and the hash is
 * sound, adds the job `schedule:<id>:<due>` through `add_job` (the Lua of
 * `ADD`) with the hash's `data`, priority 0 and the given attempts and
 * timeout, then moves the schedule to `next`. A `due` in the future, or a `next`
 * that is not a whole number above `due`, fires nothing (the latter is an error reply). The job's id already existing
 * adds nothing, but the schedule still moves on. No wake token is left
 * while `paused` exists: the job waits in `ready` for `RESUME`.
 *
 * KEYS: those of `scriptKeys`.
 * ARGV: job-key prefix, schedule-key prefix, id, due (ms), next (ms),
 * attempts, timeout (ms, -1 for none).
 * Returns 1 when a job was added and 0 otherwise.
 */
export const FIRE = defineScript(`
${WAKE_FN}
${SCHEDULE_SOUND_FN}
local prefix = ARGV[1]
local id, due = ARGV[3], ARGV[4]
-- Before any write: a next that is not a whole ms after due would leave the
-- schedule due again at once, or a job added and the schedule not moved.
if not (string.match(due, '^%d+$') and string.match(ARGV[5], '^%d+$')
	and tonumber(ARGV[5]) > tonumber(due)) then
	return redis.error_reply('ERR next must be a whole number of ms after due')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local DELAYED, READY, SEQ = KEYS[1], KEYS[2], KEYS[6]
-- Schedule occurrences have no group yet: nothing of the groups is written.
local GROUPED, CONCURRENCY, GPREFIX, GREADY, GQUEUED = false, 0, '', KEYS[12], KEYS[13]
local paused = redis.call('EXISTS', KEYS[9]) == 1
local function poke()
	if not paused then wake(KEYS[7]) end
end
${ADD_JOB_FN}
local score = redis.call('ZSCORE', KEYS[11], id)
if not score or tonumber(score) ~= tonumber(due) then return 0 end
-- Never early: an occurrence whose time has not come is not fired.
if tonumber(due) > now then return 0 end
local f = redis.call('HMGET', ARGV[2] .. id, ${SCHEDULE_FIELDS})
if not schedule_sound(f) then return 0 end
local added = add_job('schedule:' .. id .. ':' .. due, f[4], '0', ARGV[6], 0, -1, tonumber(ARGV[7]), '')
redis.call('ZADD', KEYS[11], string.format('%d', tonumber(ARGV[5])), id)
return added and 1 or 0
`);

/**
 * Moves a due schedule whose spec the client cannot parse out of the way: when
 * `schedules` still scores the id at `due` and the hash is sound, sets the
 * score to `until`, adding no job. A moved score, a missing or unsound hash
 * does nothing. An `until` that is not a whole number above `due` is an error
 * reply before any write, as for {@link FIRE}'s `next`.
 *
 * KEYS: schedules.
 * ARGV: schedule-key prefix, id, due (ms), until (ms).
 * Returns 1 (deferred) or 0.
 */
export const DEFER = defineScript(`
${SCHEDULE_SOUND_FN}
local due, untl = ARGV[3], ARGV[4]
if not (string.match(due, '^%d+$') and string.match(untl, '^%d+$')
	and tonumber(untl) > tonumber(due)) then
	return redis.error_reply('ERR until must be a whole number of ms after due')
end
local score = redis.call('ZSCORE', KEYS[1], ARGV[2])
if not score or tonumber(score) ~= tonumber(due) then return 0 end
local f = redis.call('HMGET', ARGV[1] .. ARGV[2], ${SCHEDULE_FIELDS})
if not schedule_sound(f) then return 0 end
redis.call('ZADD', KEYS[1], string.format('%d', tonumber(untl)), ARGV[2])
return 1
`);

/**
 * Makes the stored definition schedules match a list: each one is written
 * with `origin=definition`, keeping the stored score when `kind`, `spec`
 * and `timezone` are those already stored (so a restart does not push a
 * schedule's next occurrence) and taking `next` otherwise. A runtime
 * schedule of the same id is taken over. Every stored `origin=definition`
 * hash whose id is not in the list is deleted; runtime ones are left alone.
 * At most 1 000 schedules per call, refused whole above that, and refused
 * (an error reply, before any write) while the set holds more than 2 000 ids. The ids a
 * definition owns are kept in the set `schedulesDefinition`, which only this
 * script writes: the sweep reads that set, bounded by two calls' caps, never
 * the whole of `schedules`.
 *
 * KEYS: schedules, schedulesDefinition.
 * ARGV: schedule-key prefix, then per schedule `id, kind, spec, timezone,
 * data, next` (the timezone `''` for an `every`).
 * Returns `{written, removed}`.
 */
export const SYNC = defineScript(`
${WRITE_FN}
local prefix = ARGV[1]
local count = (#ARGV - 1) / 6
if count > 1000 then return redis.error_reply('ERR at most 1000 schedules per call') end
if redis.call('SCARD', KEYS[2]) > 2000 then
	return redis.error_reply('ERR the definition set holds more than 2000 ids')
end
local listed = {}
for i = 2, #ARGV, 6 do
	local id, kind, spec, zone, data, nxt = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3], ARGV[i + 4], ARGV[i + 5]
	local key = prefix .. id
	listed[id] = true
	redis.call('SADD', KEYS[2], id)
	local f = redis.call('HMGET', key, 'kind', 'spec', 'timezone')
	local same = f[1] == kind and f[2] == spec and (f[3] or '') == (kind == 'cron' and zone or '')
		and redis.call('ZSCORE', KEYS[1], id) ~= false
	write(key, kind, spec, zone, data, 'definition')
	if not same then redis.call('ZADD', KEYS[1], string.format('%d', tonumber(nxt)), id) end
end
local removed = 0
for _, id in ipairs(redis.call('SMEMBERS', KEYS[2])) do
	if not listed[id] then
		redis.call('SREM', KEYS[2], id)
		if redis.call('HGET', prefix .. id, 'origin') == 'definition' then
			redis.call('DEL', prefix .. id)
			redis.call('ZREM', KEYS[1], id)
			removed = removed + 1
		end
	end
end
return {count, removed}
`);

/**
 * One page of the stored schedules, by next occurrence then id: the total
 * the `schedules` zset holds, then per sound schedule `{id, kind, spec,
 * timezone, data, origin, next}` (`timezone` `''` for an `every`).
 * A hash this package could not have written is left out. `limit` is
 * capped at 1 000.
 *
 * KEYS: schedules.
 * ARGV: schedule-key prefix, offset, limit.
 */
export const SCHEDULES = defineScript(`
${SCHEDULE_SOUND_FN}
local limit = math.min(tonumber(ARGV[3]), 1000)
local out = {redis.call('ZCARD', KEYS[1])}
if limit < 1 then return out end
local page = redis.call('ZRANGE', KEYS[1], tonumber(ARGV[2]), tonumber(ARGV[2]) + limit - 1, 'WITHSCORES')
for i = 1, #page, 2 do
	local f = redis.call('HMGET', ARGV[1] .. page[i], ${SCHEDULE_FIELDS})
	if schedule_sound(f) then
		out[#out + 1] = {page[i], f[1], f[2], f[3] or '', f[4], f[5], tonumber(page[i + 1])}
	end
end
return out
`);

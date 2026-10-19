import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { QueueGroups } from '../flow-types';
import type { queueKeys } from '../keys';
import { groupArgs, scriptKeys } from './claim';
import { GROUP_FN, groupLocals } from './groups';
import { guardMode } from './groups-mode';
import { WAKE_FN } from './wake';

/*
 * Cancelling decides by a job's place and its stored `state` together, as
 * `REMOVE` does, so a hash that disagrees with its set is left alone rather
 * than deleted on the word of one of the two.
 */

/**
 * Cancels a job that is waiting, delayed or running: out of its set (`ready`,
 * `delayed` or `active`) and its hash deleted, which removes an active job's
 * token with it, so its worker's `COMPLETE`, `FAIL`, `RENEW` and `PROGRESS`
 * find no token and change nothing. The outcome `{type: 'canceled', id}` is
 * published on `events`; for an active job it also carries the run's
 * `token`, read before the hash is deleted, so a worker aborts that run and
 * never one of the same id claimed after the cancel. A waiting or delayed
 * job's event has no token: nothing runs it. On a grouped queue a waiting
 * job also leaves its group's zset and an active one frees its group's slot
 * (see `GROUP_FN`), leaving a wake token when that makes the group claimable
 * and the queue is not paused. A job that is completed,
 * failed, absent, or whose hash and set disagree changes nothing and
 * publishes nothing.
 *
 * KEYS: those of `scriptKeys`, `rate` being reserved for the rate limit.
 * ARGV: job-key prefix, id, the three group arguments (see `groupArgs`);
 * the marker check of `groupModeCheck` runs first.
 * Returns 1 (canceled) or 0 (nothing to cancel, nothing changed).
 */
export const CANCEL = defineScript(`
${WAKE_FN}${groupLocals(3)}
${GROUP_FN}
local id = ARGV[2]
local key = ARGV[1] .. id
local state = redis.call('HGET', key, 'state')
local from
if state == 'waiting' then from = KEYS[2]
elseif state == 'delayed' then from = KEYS[1]
elseif state == 'active' then from = KEYS[3] end
if not from or not redis.call('ZSCORE', from, id) then return 0 end
local token, freed = false, false
local g = group_of(key)
if state == 'active' then token = redis.call('HGET', key, 'token') end
if state == 'waiting' then ready_rem(id, g)
else
	redis.call('ZREM', from, id)
	if state == 'active' then freed = slot_freed(g) end
end
redis.call('DEL', key)
if freed and redis.call('EXISTS', KEYS[9]) == 0 then wake(KEYS[7]) end
local message = '{"type":"canceled","id":' .. cjson.encode(id)
if token then message = message .. ',"token":' .. cjson.encode(token) end
redis.call('PUBLISH', KEYS[8], message .. '}')
return 1
`);

/**
 * Cancels a job: `true` when it was waiting, delayed or running and is gone,
 * `false` when there was nothing to cancel.
 *
 * @throws QueueError `GROUPS_MISMATCH` when `groups` differs from the queue's.
 */
export async function cancel(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	id: string,
	groups?: QueueGroups,
	// Production callers pass the definition's name; only specs rely on ''.
	name = '',
): Promise<boolean> {
	const reply = await guardMode(client, keys, groups, 'cancel', name, () =>
		runScript(client, CANCEL, scriptKeys(keys), [
			keys.prefix,
			id,
			...groupArgs(keys, groups),
		]),
	);
	return reply === 1;
}

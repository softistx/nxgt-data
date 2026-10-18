import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import { scriptKeys } from './claim';

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
 * published on `events`. A job that is completed, failed, absent, or whose
 * hash and set disagree changes nothing and publishes nothing.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake, events.
 * ARGV: job-key prefix, id.
 * Returns 1 (canceled) or 0 (nothing to cancel, nothing changed).
 */
export const CANCEL = defineScript(`
local id = ARGV[2]
local key = ARGV[1] .. id
local state = redis.call('HGET', key, 'state')
local from
if state == 'waiting' then from = KEYS[2]
elseif state == 'delayed' then from = KEYS[1]
elseif state == 'active' then from = KEYS[3] end
if not from or not redis.call('ZSCORE', from, id) then return 0 end
redis.call('ZREM', from, id)
redis.call('DEL', key)
redis.call('PUBLISH', KEYS[8], '{"type":"canceled","id":' .. cjson.encode(id) .. '}')
return 1
`);

/**
 * Cancels a job: `true` when it was waiting, delayed or running and is gone,
 * `false` when there was nothing to cancel.
 */
export async function cancel(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	id: string,
): Promise<boolean> {
	return (
		(await runScript(client, CANCEL, scriptKeys(keys), [keys.prefix, id])) === 1
	);
}

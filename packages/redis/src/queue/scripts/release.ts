import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import type { QueueDefinition } from '../types/queue';
import { CLAIM_FN } from './claim/body';
import { groupArgs, scriptKeys } from './claim/claim';
import { parseReleased } from './claim/replies';
import { groupLocals } from './groups/groups';
import { guardMode } from './groups/mode';

/**
 * Gives back jobs a claim took for a worker that closed before starting
 * them, as if the claim had never taken them: out of `active`, `attempt - 1`,
 * `state=waiting`, the token removed, back in `ready` (through `ready_add`,
 * scored from the stored `priority` with a fresh `INCR seq`, as a reclaim
 * does), the group's slot freed when the `ZREM` answered 1. One `wake` token
 * follows when a released job or a freed group is claimable and the queue is
 * not paused.
 *
 * Token-fenced, as a settle is: a job is given back only while its hash
 * holds the token it was claimed with and says `active`, and only if it is
 * one this package could have written (`sound`, with `group`) whose
 * `attempt` is at least 1. Anything else — settled, canceled, reclaimed,
 * claimed again, or a hash of another shape — is skipped and left as it is,
 * never repaired: its lease lapses as before. It takes {@link CLAIM_FN} only
 * for its helpers (`sound`, `ready_score`, `GROUP_FN`'s, `wake`).
 *
 * KEYS: those of `scriptKeys` (it reads `ready`, `active`, `seq`, `wake`,
 * `paused` and the groups' three).
 * ARGV: job-key prefix, the three group arguments (see `groupArgs`), then
 * per job `id, token`; the marker check of `groupModeCheck` runs first.
 * Returns the ids given back.
 */
export const RELEASE = defineScript(`
local prefix = ARGV[1]${groupLocals(2)}
${CLAIM_FN}
local released, claimable = {}, false
for i = 5, #ARGV, 2 do
	local id, token = ARGV[i], ARGV[i + 1]
	local key = prefix .. id
	local f = redis.call('HMGET', key, 'data', 'attempt', 'attempts', 'priority', 'timeout', 'group', 'state', 'token')
	if f[8] == token and f[7] == 'active' and sound(f) and tonumber(f[2]) >= 1 then
		local g = f[6] or ''
		if redis.call('ZREM', KEYS[3], id) == 1 and slot_freed(g) then claimable = true end
		redis.call('HSET', key, 'state', 'waiting', 'attempt', int(tonumber(f[2]) - 1))
		redis.call('HDEL', key, 'token')
		if ready_add(id, ready_score(f[4]), g) then claimable = true end
		released[#released + 1] = id
	end
end
if claimable and redis.call('EXISTS', KEYS[9]) == 0 then wake(KEYS[7]) end
return released
`);

/**
 * Gives back `jobs`, claimed under their tokens and never started, in one
 * script; resolves to the ids given back (a job whose token no longer holds
 * is left alone). No round trip for none.
 *
 * @throws QueueError `GROUPS_MISMATCH` when `groups` differs from the queue's.
 */
export async function release(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	definition: Pick<QueueDefinition<never>, 'name' | 'groups'>,
	jobs: readonly { id: string; token: string }[],
): Promise<string[]> {
	if (jobs.length === 0) return [];
	const argv = [
		keys.prefix,
		...groupArgs(keys, definition.groups),
		...jobs.flatMap((job) => [job.id, job.token]),
	];
	return parseReleased(
		await guardMode(
			client,
			keys,
			definition.groups,
			'release',
			definition.name,
			() => runScript(client, RELEASE, scriptKeys(keys), argv),
		),
	);
}

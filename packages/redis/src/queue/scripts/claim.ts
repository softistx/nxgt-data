import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { QueueGroups, QueueRate } from '../flow-types';
import type { queueKeys } from '../keys';
import { CLAIM_FN, NOW_LUA } from './claim-body';
import { groupLocals } from './groups';
import { guardMode } from './groups-mode';
import { type ClaimReply, parseClaimReply } from './replies';

/**
 * Takes up to `n` jobs: reclaims, promotes and pops as {@link CLAIM_FN} says.
 *
 * KEYS: delayed, ready, active, completed, failed, seq, wake, events, paused,
 * rate, schedules, groupsReady, groupsQueued, groupsMode.
 * ARGV: job-key prefix, n, lease (ms), the rate's `per` (ms), `limit` and
 * `burst` (`0 0 0` for none; see {@link rateArgs}), the schedule-key prefix,
 * the three group arguments (see {@link groupArgs}), then `n` tokens.
 * Returns `{jobs, stalled, invalid, next, due}`.
 */
export const CLAIM = defineScript(`
local prefix = ARGV[1]${groupLocals(8)}
${CLAIM_FN}
${NOW_LUA}
local tokens = {}
for i = 11, #ARGV do tokens[#tokens + 1] = ARGV[i] end
return claim(tonumber(ARGV[2]), tonumber(ARGV[3]), tokens, now, rate_of(4, now_us), ARGV[7])
`);

/**
 * The keys of one queue, as a script takes them: `CLAIM_FN`'s seven, then
 * `events` (which only the scripts that publish read), `paused`, `rate`,
 * `schedules`, then `groupsReady`, `groupsQueued` and `groupsMode`.
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
		keys.paused,
		keys.rate,
		keys.schedules,
		keys.groupsReady,
		keys.groupsQueued,
		keys.groupsMode,
	];
}

/**
 * A queue's groups as the scripts' ARGV takes them: `'1'`, the cap (0 for
 * none) and the group key prefix, or `'0'` for an ungrouped queue.
 */
export function groupArgs(
	keys: ReturnType<typeof queueKeys>,
	groups: QueueGroups | undefined,
): (string | number)[] {
	return groups ? ['1', groups.concurrency, keys.group] : ['0', 0, keys.group];
}

/**
 * A queue's rate as the scripts' ARGV takes it: `per` (ms), `limit`, `burst`,
 * or three zeros for none.
 */
export function rateArgs(rate: QueueRate | undefined): number[] {
	return rate ? [rate.per, rate.limit, rate.burst] : [0, 0, 0];
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
 * @param rate - the queue's `rateLimit`, or none.
 * @param groups - the queue's `groups`, or none for an ungrouped queue.
 */
export async function claim(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	n: number,
	lease: number,
	rate: QueueRate | undefined,
	groups?: QueueGroups,
	name = '',
): Promise<ClaimReply> {
	const tokens = Array.from({ length: n }, newToken);
	const argv = [
		keys.prefix,
		n,
		lease,
		...rateArgs(rate),
		keys.schedule,
		...groupArgs(keys, groups),
		...tokens,
	];
	return parseClaimReply(
		await guardMode(client, keys, groups, 'claim', name, () =>
			runScript(client, CLAIM, scriptKeys(keys), argv),
		),
	);
}

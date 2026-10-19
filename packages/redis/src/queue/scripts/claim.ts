import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import { CLAIM_FN, NOW_LUA } from './claim-body';
import { type ClaimReply, parseClaimReply } from './replies';

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

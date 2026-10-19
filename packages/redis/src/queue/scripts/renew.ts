import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';
import { parseLost } from './claim/replies';

/**
 * Pushes the lease of every entry that still holds its token to
 * `now + lease`, and returns the ids that do not. One call per worker per
 * lease third, whatever its concurrency.
 *
 * `ZADD XX` never resurrects an id a reclaim already took out of `active`:
 * the token check is the guard, and `XX` is its belt.
 *
 * KEYS: active.
 * ARGV: job-key prefix, lease (ms), then per entry `id, token`.
 * Returns the ids whose token no longer holds.
 */
export const RENEW = defineScript(`
local prefix = ARGV[1]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local until_ms = string.format('%d', now + tonumber(ARGV[2]))
local lost = {}
for i = 3, #ARGV, 2 do
	local id = ARGV[i]
	if redis.call('HGET', prefix .. id, 'token') == ARGV[i + 1] then
		redis.call('ZADD', KEYS[1], 'XX', until_ms, id)
	else
		lost[#lost + 1] = id
	end
end
return lost
`);

/** Renews the leases of `entries`; resolves to the ids whose token was lost. */
export async function renew(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	lease: number,
	entries: readonly { id: string; token: string }[],
): Promise<string[]> {
	return parseLost(
		await runScript(
			client,
			RENEW,
			[keys.active],
			[keys.prefix, lease, ...entries.flatMap((e) => [e.id, e.token])],
		),
	);
}

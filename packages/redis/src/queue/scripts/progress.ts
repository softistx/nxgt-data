import type { RedisClient } from 'bun';
import { defineScript, runScript } from '../../scripts/run-script';
import type { queueKeys } from '../keys';

/**
 * Records a running job's progress if its token still holds, so a worker
 * that lost its lease, or whose job was canceled, writes nothing. The value
 * is stored as the caller formatted it: the client has checked that it is a
 * number from 0 to 100.
 *
 * KEYS: the job's hash.
 * ARGV: token, value.
 * Returns 1 (written) or 0 (the token no longer holds, nothing changed).
 */
export const PROGRESS = defineScript(`
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'progress', ARGV[2])
return 1
`);

/** Records `value` as the progress of a job; whether the token still held. */
export async function progress(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	id: string,
	token: string,
	value: number,
): Promise<boolean> {
	return (
		(await runScript(client, PROGRESS, [keys.job(id)], [token, value])) === 1
	);
}

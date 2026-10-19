import type { RedisClient } from 'bun';
import { QueueError } from '../../../errors/queue-error';
import type { queueKeys } from '../../binding/keys';
import type { QueueGroups } from '../../types/flow-types';
import { MISMATCH } from './groups';

/** A queue's groups mode as the `groups:mode` key holds it: `'0'` or `'1:<concurrency>'`. */
export function modeOf(groups: QueueGroups | undefined): string {
	return groups ? `1:${groups.concurrency}` : '0';
}

/**
 * A stored mode in words, for the error: `no groups`, `groups { concurrency: 2 }`
 * or `groups {}`. A deleted marker (`null`) and a value this package never
 * wrote are named as such, never parsed.
 */
function describeMode(mode: string | null): string {
	if (mode === null) return 'no marker (deleted meanwhile)';
	const match = /^(?:(0)|1:(\d+))$/.exec(mode);
	if (!match) return 'an unknown mode';
	if (match[1] !== undefined) return 'no groups';
	return match[2] === '0' ? 'groups {}' : `groups { concurrency: ${match[2]} }`;
}

/**
 * Runs a script call that takes the groups arguments and turns the script's
 * `ERR groups mismatch` into a `QueueError` of code `GROUPS_MISMATCH` naming
 * both modes. The stored mode is read (one `GET`) only on that error path, so
 * the call itself pays no round trip. Any other failure is rethrown as it is.
 */
export async function guardMode<T>(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	groups: QueueGroups | undefined,
	call: string,
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes(MISMATCH)) {
			throw error;
		}
		const stored = await client.get(keys.groupsMode);
		throw new QueueError(
			'GROUPS_MISMATCH',
			name,
			`${call} on "${name}": the queue was started with ${describeMode(stored)} and this process has ${describeMode(modeOf(groups))}; every process must share groups (drain the queue and delete ${keys.groupsMode} to change it)`,
		);
	}
}

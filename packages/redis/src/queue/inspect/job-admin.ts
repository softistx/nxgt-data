import type { RedisClient } from 'bun';
import { QueueError } from '../../errors/queue-error';
import { runScript } from '../../scripts/run-script';
import type { queueKeys } from '../binding/keys';
import { REMOVE, RETRY } from '../scripts/admin';
import { groupArgs, scriptKeys } from '../scripts/claim/claim';
import { guardMode } from '../scripts/groups/groups-mode';
import type { QueueGroups } from '../types/flow-types';

type Keys = ReturnType<typeof queueKeys>;
type Named = { name: string; groups?: QueueGroups | undefined };

/**
 * Puts a failed job back to `waiting`, its attempts reset, and with `fresh`
 * its stored step values cleared.
 *
 * @throws QueueError `NOT_FOUND` when the job is not in `failed`.
 */
export async function retryJob(
	client: RedisClient,
	keys: Keys,
	definition: Named,
	id: string,
	fresh: boolean,
): Promise<void> {
	const reply = await guardMode(
		client,
		keys,
		definition.groups,
		'retry',
		definition.name,
		() =>
			runScript(client, RETRY, scriptKeys(keys), [
				keys.prefix,
				id,
				fresh ? '1' : '0',
				...groupArgs(keys, definition.groups),
			]),
	);
	if (reply !== 1) {
		throw new QueueError(
			'NOT_FOUND',
			definition.name,
			`retry on "${definition.name}": job "${id}" is not failed`,
			id,
		);
	}
}

/**
 * Removes a job that is not running.
 *
 * @throws QueueError `ACTIVE` for a running job, `NOT_FOUND` for none.
 */
export async function removeJob(
	client: RedisClient,
	keys: Keys,
	definition: Named,
	id: string,
): Promise<void> {
	const reply = await guardMode(
		client,
		keys,
		definition.groups,
		'remove',
		definition.name,
		() =>
			runScript(client, REMOVE, scriptKeys(keys), [
				keys.prefix,
				id,
				...groupArgs(keys, definition.groups),
			]),
	);
	if (reply === 2) {
		throw new QueueError(
			'ACTIVE',
			definition.name,
			`remove on "${definition.name}": job "${id}" is running`,
			id,
		);
	}
	if (reply !== 1) {
		throw new QueueError(
			'NOT_FOUND',
			definition.name,
			`remove on "${definition.name}": no job "${id}"`,
			id,
		);
	}
}

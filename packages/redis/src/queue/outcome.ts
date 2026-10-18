import type { RedisClient } from 'bun';
import { parseEvent } from './events/message';
import type { queueKeys } from './keys';
import { parseStoredError } from './view';

export type Keys = ReturnType<typeof queueKeys>;
export type Failure = { name: string; message: string };

/** What a job's final outcome is, read from its hash or heard on the channel. */
export type Outcome =
	| { kind: 'completed'; result: string | undefined }
	| { kind: 'failed'; error: Failure | undefined }
	| { kind: 'canceled' }
	| { kind: 'absent' };

/** The outcome a message on the events channel tells for `id`, if it is about `id`. */
export function fromMessage(text: string, id: string): Outcome | undefined {
	const event = parseEvent(text);
	if (event === undefined || event.id !== id) return undefined;
	switch (event.type) {
		case 'completed':
			return {
				kind: 'completed',
				result:
					event.result === undefined ? undefined : JSON.stringify(event.result),
			};
		case 'failed':
			return {
				kind: 'failed',
				error: parseStoredError(JSON.stringify(event.error)),
			};
		case 'canceled':
			return { kind: 'canceled' };
	}
}

/** The outcome a job's stored state already tells; `undefined` while it is not final. */
export async function readStored(
	client: RedisClient,
	keys: Keys,
	id: string,
): Promise<Outcome | undefined> {
	const [state, result, error] = (await client.hmget(keys.job(id), [
		'state',
		'result',
		'error',
	])) as (string | null)[];
	if (state === null || state === undefined) return { kind: 'absent' };
	if (state === 'completed') {
		return { kind: 'completed', result: result ?? undefined };
	}
	if (state === 'failed')
		return { kind: 'failed', error: parseStoredError(error) };
	return undefined;
}

/** The outcomes the queue's scripts publish on its `events` channel. */
const TYPES = ['completed', 'failed', 'canceled'] as const;

/** One message on a queue's `events` channel, as the scripts publish it. */
export type QueueEvent = {
	type: (typeof TYPES)[number];
	id: string;
	/** On a `canceled` event of a running job: the token of the run it ends. */
	token?: string;
	/** On a `completed` event of a job with a result: the result, parsed from JSON. */
	result?: unknown;
	/** On a `failed` event: the stored `{name, message}`, parsed from JSON. */
	error?: unknown;
};

/**
 * Reads one message of a queue's `events` channel: `undefined` for text that
 * is not JSON, not an object, of a type the scripts never publish, or without
 * a string `id`. A `token` that is not a string is left out. The handle and
 * the worker both read through it, so the two never disagree on a message.
 */
export function parseEvent(text: string): QueueEvent | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (raw === null || typeof raw !== 'object') return undefined;
	const { type, id, token, result, error } = raw as {
		type?: unknown;
		id?: unknown;
		token?: unknown;
		result?: unknown;
		error?: unknown;
	};
	if (typeof id !== 'string') return undefined;
	if (!TYPES.includes(type as QueueEvent['type'])) return undefined;
	const event: QueueEvent = { type: type as QueueEvent['type'], id };
	if (typeof token === 'string') event.token = token;
	if (result !== undefined) event.result = result;
	if (error !== undefined) event.error = error;
	return event;
}

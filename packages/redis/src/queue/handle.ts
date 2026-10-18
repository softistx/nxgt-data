import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { durationMs } from './duration';
import { decodeResult } from './encode';
import { parseEvent } from './events/message';
import { flush, listen } from './events/subscriber';
import type { JobHandle } from './handle-types';
import type { queueKeys } from './keys';
import type { ResultOf } from './result-types';
import { cancel } from './scripts/cancel';
import { clampTimeout } from './timers';
import type { QueueDefinition } from './types';
import { parseStoredError } from './view';

/** How often a waiting `finished` re-reads the job: the net under a lost event. */
const REREAD_MS = 5000;

type Keys = ReturnType<typeof queueKeys>;
type Failure = { name: string; message: string };

/** What `finished` waits with: data only, no closure. */
type Waiting = {
	readonly client: RedisClient;
	readonly definition: QueueDefinition<z.ZodType, z.ZodType | undefined>;
	readonly keys: Keys;
	readonly id: string;
	readonly rereadMs: number;
};

/** What a job's final outcome is, read from its hash or heard on the channel. */
type Outcome =
	| { kind: 'completed'; result: string | undefined }
	| { kind: 'failed'; error: Failure | undefined }
	| { kind: 'canceled' }
	| { kind: 'absent' };

/** The outcome a message on the events channel tells for `id`, if it is about `id`. */
function fromMessage(text: string, id: string): Outcome | undefined {
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
async function readStored(
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

/** `finished`'s rejection: names the queue and the job, never the data. */
function failure(
	waiting: Waiting,
	code: 'FAILED' | 'CANCELED' | 'NOT_FOUND' | 'INVALID' | 'WAIT_TIMEOUT',
	what: string,
	last?: Failure,
): QueueError {
	const queue = waiting.definition.name;
	return new QueueError(
		code,
		queue,
		`finished on "${queue}": job "${waiting.id}" ${what}`,
		waiting.id,
		last,
	);
}

/** Settles `finished`'s promise by a final outcome. */
function settleWith(
	waiting: Waiting,
	outcome: Outcome,
	resolve: (value: unknown) => void,
	reject: (reason: QueueError) => void,
): void {
	switch (outcome.kind) {
		case 'completed': {
			const read = decodeResult(waiting.definition, outcome.result);
			if (read.ok) resolve(read.value);
			else
				reject(
					failure(waiting, 'INVALID', 'has a result the result schema refuses'),
				);
			return;
		}
		case 'failed':
			reject(failure(waiting, 'FAILED', 'failed', outcome.error));
			return;
		case 'canceled':
			reject(failure(waiting, 'CANCELED', 'was canceled'));
			return;
		case 'absent':
			reject(failure(waiting, 'NOT_FOUND', 'is not in the queue'));
	}
}

/** `finished`'s `timeout` in milliseconds, `undefined` for none: a bare `TypeError` that never prints the value. */
function resolveWait(
	waiting: Waiting,
	options: { timeout?: unknown } | undefined,
): number | undefined {
	if (options?.timeout === undefined) return undefined;
	const ms = durationMs(options.timeout);
	if (ms === undefined || ms < 1) {
		throw new TypeError(
			`finished on "${waiting.definition.name}": timeout is at least 1 millisecond, as a whole number or a string such as '10m'`,
		);
	}
	return clampTimeout(ms);
}

/**
 * Waits for job `waiting.id`'s outcome.
 *
 * It listens before it reads the stored state, so an outcome published
 * between the two is not lost, and re-reads that state every `rereadMs`
 * while it waits, so an event the connection dropped delays the outcome by at
 * most that long instead of hanging. It unlistens on every path.
 */
async function waitFinished(
	waiting: Waiting,
	options: { timeout?: unknown } | undefined,
): Promise<unknown> {
	const { client, keys, id } = waiting;
	const timeoutMs = resolveWait(waiting, options);
	let resolve!: (value: unknown) => void;
	let reject!: (reason: QueueError) => void;
	const done = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// A rejection raised before `await done` is reached is not unhandled.
	done.catch(() => undefined);
	const apply = (outcome: Outcome | undefined) => {
		if (outcome) settleWith(waiting, outcome, resolve, reject);
	};
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(
					() =>
						reject(failure(waiting, 'WAIT_TIMEOUT', 'did not finish in time')),
					timeoutMs,
				);
	let poll: ReturnType<typeof setInterval> | undefined;
	let unlisten: (() => Promise<void>) | undefined;
	try {
		unlisten = await listen(client, keys.events, (text) =>
			apply(fromMessage(text, id)),
		);
		// An absent job is believed after two re-reads in a row: with
		// keepCompleted false a completed job is deleted before its event lands.
		let absent = 0;
		poll = setInterval(() => {
			// A failed read, or a throw in `apply`, waits for the next re-read:
			// nothing raised here may reach the process as an unhandled rejection.
			readStored(client, keys, id)
				.then((outcome) => {
					absent = outcome?.kind === 'absent' ? absent + 1 : 0;
					if (outcome?.kind !== 'absent' || absent >= 2) apply(outcome);
				})
				.catch(() => undefined);
		}, waiting.rereadMs);
		const first = await readStored(client, keys, id);
		// A job settled and deleted between the SUBSCRIBE and this read (a
		// cancel, or a complete with keepCompleted false) reads absent while its
		// event is still on the subscriber's socket: the PING there lets it land
		// first, and an outcome heard settles `done` before absent can.
		if (first?.kind === 'absent') await flush(client);
		apply(first);
		return await done;
	} finally {
		clearTimeout(timer);
		clearInterval(poll);
		await unlisten?.();
	}
}

/** The handle `add` returns for job `id`. `rereadMs` is internal, for tests. */
export function jobHandle<
	S extends z.ZodType,
	R extends z.ZodType | undefined = undefined,
>(
	client: RedisClient,
	definition: QueueDefinition<S, R>,
	keys: Keys,
	id: string,
	deduplicated: boolean,
	rereadMs: number = REREAD_MS,
): JobHandle<R> {
	const waiting: Waiting = { client, definition, keys, id, rereadMs };
	return {
		id,
		deduplicated,
		finished: (options) =>
			waitFinished(waiting, options) as Promise<ResultOf<R>>,
		cancel: () => cancel(client, keys, id),
	};
}

import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { durationMs } from './duration';
import { decodeResult } from './encode';
import { listen } from './events/subscriber';
import type { queueKeys } from './keys';
import { cancel } from './scripts/cancel';
import type { JobHandle, QueueDefinition, ResultOf } from './types';
import { parseStoredError } from './view';

/** How often a waiting `finished` re-reads the job: the net under a lost event. */
const REREAD_MS = 5000;

type Keys = ReturnType<typeof queueKeys>;
type Failure = { name: string; message: string };

/** What a job's final outcome is, read from its hash or heard on the channel. */
type Outcome =
	| { kind: 'completed'; result: string | undefined }
	| { kind: 'failed'; error: Failure | undefined }
	| { kind: 'canceled' }
	| { kind: 'absent' };

/** The outcome a message on the events channel tells for `id`, if it is about `id`. */
function fromMessage(text: string, id: string): Outcome | undefined {
	let message: {
		type?: unknown;
		id?: unknown;
		result?: unknown;
		error?: unknown;
	};
	try {
		message = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (message === null || typeof message !== 'object' || message.id !== id) {
		return undefined;
	}
	switch (message.type) {
		case 'completed':
			return {
				kind: 'completed',
				result:
					message.result === undefined
						? undefined
						: JSON.stringify(message.result),
			};
		case 'failed':
			return {
				kind: 'failed',
				error: parseStoredError(JSON.stringify(message.error)),
			};
		case 'canceled':
			return { kind: 'canceled' };
		default:
			return undefined;
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

/**
 * The handle `add` returns for job `id`.
 *
 * `finished` listens before it reads the stored state, so an outcome
 * published between the two is not lost, and re-reads that state every
 * `rereadMs` while it waits, so an event the connection dropped delays the
 * outcome by at most that long instead of hanging. It unlistens on every path.
 * `rereadMs` is internal, for tests.
 */
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
	const queue = definition.name;
	const error = (
		code: 'FAILED' | 'CANCELED' | 'NOT_FOUND' | 'INVALID' | 'WAIT_TIMEOUT',
		what: string,
		last?: Failure,
	) =>
		new QueueError(
			code,
			queue,
			`finished on "${queue}": job "${id}" ${what}`,
			id,
			last,
		);

	function settleWith(
		outcome: Outcome,
		resolve: (value: ResultOf<R>) => void,
		reject: (reason: QueueError) => void,
	) {
		switch (outcome.kind) {
			case 'completed': {
				const read = decodeResult(definition, outcome.result);
				if (read.ok) resolve(read.value as ResultOf<R>);
				else reject(error('INVALID', 'has a result the result schema refuses'));
				return;
			}
			case 'failed':
				reject(error('FAILED', 'failed', outcome.error));
				return;
			case 'canceled':
				reject(error('CANCELED', 'was canceled'));
				return;
			case 'absent':
				reject(error('NOT_FOUND', 'is not in the queue'));
		}
	}

	return {
		id,
		deduplicated,
		async finished(options) {
			let timeoutMs: number | undefined;
			if (options?.timeout !== undefined) {
				timeoutMs = durationMs(options.timeout);
				if (timeoutMs === undefined || timeoutMs < 1) {
					throw new TypeError(
						`finished on "${queue}": timeout is at least 1 millisecond, as a whole number or a string such as '10m'`,
					);
				}
			}
			let resolve!: (value: ResultOf<R>) => void;
			let reject!: (reason: QueueError) => void;
			const done = new Promise<ResultOf<R>>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			// A rejection raised before `await done` is reached is not unhandled.
			done.catch(() => undefined);
			const apply = (outcome: Outcome | undefined) => {
				if (outcome) settleWith(outcome, resolve, reject);
			};
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(
							() => reject(error('WAIT_TIMEOUT', 'did not finish in time')),
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
					readStored(client, keys, id).then(
						(outcome) => {
							absent = outcome?.kind === 'absent' ? absent + 1 : 0;
							if (outcome?.kind !== 'absent' || absent >= 2) apply(outcome);
						},
						() => undefined,
					);
				}, rereadMs);
				apply(await readStored(client, keys, id));
				return await done;
			} finally {
				clearTimeout(timer);
				clearInterval(poll);
				await unlisten?.();
			}
		},
		cancel: () => cancel(client, keys, id),
	};
}

import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { QueueError } from '../errors/queue-error';
import { durationMs } from './duration';
import { decodeResult } from './encode';
import { listenRaced } from './events/listen-raced';
import { flush } from './events/subscriber';
import type { JobHandle } from './handle-types';
import { type QueueLife, refuseClosed, trackWait } from './life';
import {
	type Failure,
	fromMessage,
	type Keys,
	type Outcome,
	readStored,
} from './outcome';
import type { ResultOf } from './result-types';
import { cancel } from './scripts/cancel';
import { clampTimeout } from './timers';
import type { QueueDefinition } from './types';

/** How often a waiting `finished` re-reads the job: the net under a lost event. */
const REREAD_MS = 5000;

/** What a wait's `over` promise resolves with once the wait has settled. */
const OVER: unique symbol = Symbol('over');

/** What `finished` waits with: data only, no closure. */
type Waiting = {
	readonly client: RedisClient;
	readonly definition: QueueDefinition<z.ZodType, z.ZodType | undefined>;
	readonly keys: Keys;
	readonly id: string;
	readonly rereadMs: number;
	readonly life: QueueLife | undefined;
};

/** `finished`'s rejection: names the queue and the job, never the data. */
function failure(
	waiting: Waiting,
	code:
		| 'FAILED'
		| 'CANCELED'
		| 'NOT_FOUND'
		| 'INVALID'
		| 'WAIT_TIMEOUT'
		| 'CLOSED',
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
	refuseClosed(waiting.life, 'finished', waiting.definition.name);
	const timeoutMs = resolveWait(waiting, options);
	let resolve!: (value: unknown) => void;
	let reject!: (reason: QueueError) => void;
	const done = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// A rejection raised before `await done` is reached is not unhandled.
	done.catch(() => undefined);
	// Resolves once `done` settled either way, so a race against it never throws.
	const over = done.then(
		(): typeof OVER => OVER,
		(): typeof OVER => OVER,
	);
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
	const leave = trackWait(waiting.life, client, () =>
		reject(failure(waiting, 'CLOSED', 'was pending when the Redis closed')),
	);
	let poll: ReturnType<typeof setInterval> | undefined;
	let listener: ReturnType<typeof listenRaced> | undefined;
	try {
		// Raced like the reads, so a hung SUBSCRIBE cannot defeat the timeout.
		listener = listenRaced(
			client,
			keys.events,
			(text) => apply(fromMessage(text, id)),
			over,
		);
		if ((await listener.raced) === OVER) return await done;
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
		// Each await below is raced against `over`: a hung connection must not
		// delay the timeout, and a read answering after it is ignored.
		const first = await Promise.race([readStored(client, keys, id), over]);
		if (first === OVER) return await done;
		// A job settled and deleted between the SUBSCRIBE and this read (a
		// cancel, or a complete with keepCompleted false) reads absent while its
		// event is still on the subscriber's socket: the PING there lets it land
		// first, and an outcome heard settles `done` before absent can.
		if (first?.kind === 'absent') await Promise.race([flush(client), over]);
		apply(first);
		return await done;
	} finally {
		clearTimeout(timer);
		clearInterval(poll);
		leave(listener?.stop() ?? Promise.resolve());
	}
}

/** The handle `add` returns for job `id`. `rereadMs` and `life` are internal: for tests, and for a wired queue. */
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
	life?: QueueLife,
): JobHandle<R> {
	const waiting: Waiting = { client, definition, keys, id, rereadMs, life };
	return {
		id,
		deduplicated,
		finished: (options) =>
			waitFinished(waiting, options) as Promise<ResultOf<R>>,
		cancel: () => cancel(client, keys, id),
	};
}

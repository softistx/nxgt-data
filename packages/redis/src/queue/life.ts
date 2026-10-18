import { QueueError } from '../errors/queue-error';
import type { Worker } from './worker/types';

/**
 * What a wired queue knows of its Redis's close: plain data, shared by every
 * queue of one Redis. A queue bound by hand has none and is never refused.
 *
 * `close` runs in two phases: `closing` refuses `work` and closes the
 * workers with their grace; `closed` then refuses `add`, `addMany` and
 * `finished`, and ends every `finished` still waiting. Admin calls
 * (`get`, `list`, `counts`, `retry`, `remove`, `cancel`) are never refused.
 */
export interface QueueLife {
	state: 'open' | 'closing' | 'closed';
	/** The workers `work` started and nobody closed yet. */
	readonly workers: Set<Worker>;
	/** One promise per pending `finished`, settled once it has unlistened. */
	readonly waits: Set<Promise<void>>;
	/** Aborts when the refusal phase begins: pending `finished` calls reject. */
	readonly closed: AbortController;
}

/** A life for a Redis that is open. */
export function openLife(): QueueLife {
	return {
		state: 'open',
		workers: new Set(),
		waits: new Set(),
		closed: new AbortController(),
	};
}

/**
 * Throws `CLOSED` when the life refuses `call`: `work` from `closing`, the
 * others from `closed`. A queue without a life never refuses. Callers in
 * async paths turn the throw into a rejection.
 */
export function refuseClosed(
	life: QueueLife | undefined,
	call: 'add' | 'addMany' | 'finished' | 'work',
	queue: string,
): void {
	if (!life || life.state === 'open') return;
	if (life.state === 'closing' && call !== 'work') return;
	throw new QueueError(
		'CLOSED',
		queue,
		`${call} on "${queue}": the Redis is ${life.state}`,
	);
}

/**
 * Records `worker` in the life and answers it with a `close` that forgets it
 * first. `Object.create`, not a spread, so the rest of the worker stays live.
 */
export function trackWorker(life: QueueLife, worker: Worker): Worker {
	life.workers.add(worker);
	const forget = (options?: Parameters<Worker['close']>[0]) => {
		life.workers.delete(worker);
		return worker.close(options);
	};
	return Object.create(worker, {
		close: { enumerable: true, value: forget },
		[Symbol.asyncDispose]: { enumerable: false, value: () => forget() },
	}) as Worker;
}

/**
 * Registers a pending `finished`. `onClosed` runs when the refusal phase
 * begins. The answer is called once the wait ended, with the promise of its
 * unlisten: the wait leaves `life.waits` only when that settled, so
 * {@link closeLife} knows no listener outlives it. Without a life it does nothing.
 */
export function trackWait(
	life: QueueLife | undefined,
	onClosed: () => void,
): (unlistened: Promise<void>) => void {
	if (!life) return () => undefined;
	let settle!: () => void;
	const wait = new Promise<void>((resolve) => {
		settle = resolve;
	});
	life.waits.add(wait);
	const { signal } = life.closed;
	signal.addEventListener('abort', onClosed, { once: true });
	return (unlistened) => {
		signal.removeEventListener('abort', onClosed);
		unlistened.then(() => {
			life.waits.delete(wait);
			settle();
		});
	};
}

const closing = new WeakMap<QueueLife, Promise<void>>();

async function run(life: QueueLife, grace: number | undefined): Promise<void> {
	life.state = 'closing';
	const workers = [...life.workers];
	life.workers.clear();
	const results = await Promise.allSettled(
		workers.map((worker) =>
			worker.close(grace === undefined ? undefined : { grace }),
		),
	);
	life.state = 'closed';
	life.closed.abort();
	await Promise.all([...life.waits]);
	const failed = results.find((result) => result.status === 'rejected');
	if (failed) throw failed.reason;
}

/**
 * Closes a life in its two phases. `grace` is already checked; `undefined`
 * gives each worker its default. A worker whose close rejects does not keep
 * the others open: the first error is rethrown once both phases are done.
 * Resolves only after every pending `finished` has rejected `CLOSED` and
 * unlistened. A second call returns the first call's promise.
 */
export function closeLife(
	life: QueueLife,
	grace: number | undefined,
): Promise<void> {
	let promise = closing.get(life);
	if (!promise) {
		promise = run(life, grace);
		closing.set(life, promise);
	}
	return promise;
}

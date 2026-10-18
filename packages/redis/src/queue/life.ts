import { QueueError } from '../errors/queue-error';
import { clampTimeout, RELEASE_MS } from './timers';
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
	/** The promise of {@link closeLife}, once it ran: a second call returns it. */
	closing?: Promise<void>;
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
 * Records `worker` in the life and answers it with a `close` that stays
 * recorded until the close resolves: {@link closeLife} then awaits the close
 * in flight (a worker's `close` is memoised) instead of missing it, and a
 * close refused for a bad `grace` leaves the worker for `closeLife` to close.
 * `Object.create`, not a spread, so the rest of the worker stays live.
 */
export function trackWorker(life: QueueLife, worker: Worker): Worker {
	life.workers.add(worker);
	const forget = (options?: Parameters<Worker['close']>[0]) => {
		const closing = worker.close(options);
		closing.then(
			() => life.workers.delete(worker),
			() => undefined,
		);
		return closing;
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

/** Closes one worker; a synchronous throw is a rejection like any other. */
async function closeOne(worker: Worker, grace: number | undefined) {
	await worker.close(grace === undefined ? undefined : { grace });
}

/** Resolves once `waits` all settled, or after {@link RELEASE_MS}: the timer never outlives the call. */
async function released(waits: readonly Promise<void>[]): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, clampTimeout(RELEASE_MS));
	});
	try {
		await Promise.race([Promise.all(waits).then(() => undefined), expired]);
	} finally {
		clearTimeout(timer);
	}
}

async function run(life: QueueLife, grace: number | undefined): Promise<void> {
	life.state = 'closing';
	const results = await Promise.allSettled(
		[...life.workers].map((worker) => closeOne(worker, grace)),
	);
	life.workers.clear();
	life.state = 'closed';
	life.closed.abort();
	await released([...life.waits]);
	const failed = results.find((result) => result.status === 'rejected');
	if (failed) throw failed.reason;
}

/**
 * Closes a life in its two phases. `grace` is already checked; `undefined`
 * gives each worker its default. A worker whose close rejects does not keep
 * the others open: the first error, in the order the workers were started, is
 * rethrown once both phases are done. Resolves once every pending `finished`
 * has rejected `CLOSED` and unlistened, or after {@link RELEASE_MS} when a
 * connection never answers its UNSUBSCRIBE. A second call returns the first
 * call's promise: its `grace` is ignored.
 */
export function closeLife(
	life: QueueLife,
	grace: number | undefined,
): Promise<void> {
	life.closing ??= run(life, grace);
	return life.closing;
}

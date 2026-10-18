import { QueueError } from '../../errors/queue-error';
import { parseEvent } from '../events/message';
import { listen } from '../events/subscriber';
import type { ClaimedJob } from '../scripts/replies';
import type { WorkerContext } from './context';

/**
 * The longest a JavaScript timer waits, in milliseconds (2^31 - 1, about 24.8
 * days): a longer one fires at once. A `timeout` above it runs as this one.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** A timeout as a timer can wait it: capped at {@link MAX_TIMER_MS}; `undefined` stays no limit. */
export function clampTimeout(ms: number | undefined): number | undefined {
	return ms === undefined ? undefined : Math.min(ms, MAX_TIMER_MS);
}

/** One running job's way to be aborted, held for as long as the run is. */
export type Run = {
	readonly token: string;
	readonly controller: AbortController;
};

/** How a handler's race ended: it returned, it threw, or the run was aborted first. */
export type Outcome =
	| { kind: 'returned'; value: unknown }
	| { kind: 'threw'; error: unknown }
	| { kind: 'aborted'; reason: QueueError };

type Aborting = Pick<WorkerContext, 'runs' | 'definition'>;

const WHAT = {
	TIMEOUT: 'ran past its timeout',
	CANCELED: 'was canceled',
	LEASE_LOST: 'lost its lease',
	CLOSED: 'was aborted because the worker closed',
} as const;

/** The `signal.reason` of an abort: names the queue and the job, never its data. */
function reasonOf(
	context: Pick<Aborting, 'definition'>,
	code: keyof typeof WHAT,
	id: string,
): QueueError {
	const queue = context.definition.name;
	return new QueueError(
		code,
		queue,
		`run on "${queue}": job "${id}" ${WHAT[code]}`,
		id,
	);
}

/** Registers a claimed job's run, with the controller its handler's signal comes from. */
export function beginRun(context: Aborting, job: ClaimedJob): Run {
	const run: Run = { token: job.token, controller: new AbortController() };
	const tokens = context.runs.get(job.id) ?? new Map<string, Run>();
	tokens.set(job.token, run);
	context.runs.set(job.id, tokens);
	return run;
}

/** Forgets one run; another run of the id (claimed again under another token) stays. */
export function endRun(context: Aborting, job: ClaimedJob): void {
	const tokens = context.runs.get(job.id);
	tokens?.delete(job.token);
	if (tokens?.size === 0) context.runs.delete(job.id);
}

/**
 * Aborts the runs of `id` with `code`. With a `token`, only that run: a report
 * about an earlier run of the id never aborts the one claimed after it.
 * Answers whether a run was aborted.
 */
export function abortRun(
	context: Aborting,
	code: keyof typeof WHAT,
	id: string,
	token?: string,
): boolean {
	let aborted = false;
	for (const run of [...(context.runs.get(id)?.values() ?? [])]) {
		if (run.controller.signal.aborted) continue;
		if (token !== undefined && run.token !== token) continue;
		run.controller.abort(reasonOf(context, code, id));
		aborted = true;
	}
	return aborted;
}

/** Aborts every run still going with `CLOSED`. */
export function abortAll(context: Aborting): void {
	for (const id of [...context.runs.keys()]) abortRun(context, 'CLOSED', id);
}

/** Aborts the runs whose lease a renewal found taken, each compared by its token. */
export function abortLost(
	context: Aborting,
	lost: { id: string; token: string }[],
): void {
	for (const { id, token } of lost) abortRun(context, 'LEASE_LOST', id, token);
}

/** Starts the run's timeout, `job.timeout ?? definition.timeout`; answers the function that stops it. */
export function armTimeout(context: Aborting, job: ClaimedJob): () => void {
	const ms = clampTimeout(job.timeout ?? context.definition.timeout);
	if (ms === undefined) return () => undefined;
	const timer = setTimeout(
		() => abortRun(context, 'TIMEOUT', job.id, job.token),
		ms,
	);
	return () => clearTimeout(timer);
}

/**
 * Calls the handler and waits for it or for the abort, whichever comes first.
 * The handler's promise keeps both its handlers, so one that settles after
 * the abort is handled and its outcome dropped.
 */
export function raceAbort(
	signal: AbortSignal,
	call: () => unknown,
): Promise<Outcome> {
	return new Promise((resolve) => {
		const abort = () =>
			resolve({ kind: 'aborted', reason: reasonFrom(signal) });
		if (signal.aborted) return abort();
		signal.addEventListener('abort', abort, { once: true });
		const end = (outcome: Outcome) => {
			signal.removeEventListener('abort', abort);
			resolve(outcome);
		};
		// A throw before the first await is the handler's failure like any other.
		new Promise((run) => run(call())).then(
			(value) => end({ kind: 'returned', value }),
			(error) => end({ kind: 'threw', error }),
		);
	});
}

function reasonFrom(signal: AbortSignal): QueueError {
	return signal.reason as QueueError;
}

/**
 * Listens to the queue's events for a `canceled` one and aborts that job's
 * run with `CANCELED`. Resolves with the function that stops listening, once
 * the SUBSCRIBE is live. A cancel published before then is not heard: the
 * lease renewal reports that job as `LEASE_LOST` instead. A cancel heard
 * while a finished handler's COMPLETE is in flight emits nothing: the settle
 * is refused.
 */
export function hearCancels(
	context: WorkerContext,
): Promise<() => Promise<void>> {
	return listen(context.client, context.keys.events, (message) => {
		const event = parseEvent(message);
		// By id alone, every token of it: the CANCEL script deleted the job's hash.
		if (event?.type === 'canceled') abortRun(context, 'CANCELED', event.id);
	});
}

import type { z } from 'zod';
import { JobError } from '../../errors/job-error';
import { QueueError } from '../../errors/queue-error';
import { backoffDelay } from '../backoff';
import { decodeData, encodeResult } from '../encode';
import { claim } from '../scripts/claim';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
import { complete, fail } from '../scripts/settle';
import type { QueueDefinition } from '../types';
import {
	armTimeout,
	beginRun,
	endRun,
	type Outcome,
	type Run,
	raceAbort,
} from './abort';
import type { WorkerContext } from './context';
import { announce, emit } from './events';
import { markDrained } from './idle';
import { progressOf } from './progress';
import { stepsOf } from './steps';

function toError(thrown: unknown): { name: string; message: string } {
	return thrown instanceof Error
		? { name: thrown.name, message: thrown.message }
		: { name: 'Error', message: String(thrown) };
}

/** The wait before the next attempt, or null when the job must not be retried. */
function retryDelay(
	definition: QueueDefinition<z.ZodType, z.ZodType | undefined>,
	attempt: number,
	error: unknown,
): number | null {
	if (!(error instanceof JobError)) {
		return backoffDelay(attempt, definition.backoff);
	}
	if (!error.retry) return null;
	return error.retryIn ?? backoffDelay(attempt, definition.backoff);
}

/** Fails the attempt with `error`, and tells `failed` or `retrying` by what the script settled. */
async function failAttempt<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	error: { name: string; message: string },
	delay: number | null,
): Promise<ClaimReply> {
	const { client, keys, definition } = context;
	const reply = await fail(
		client,
		keys,
		definition,
		job.id,
		job.token,
		error,
		delay,
		context.open,
	);
	if (reply.settled && reply.final) {
		emit(context, 'failed', { id: job.id, attempt: job.attempt, error });
	} else if (reply.settled && delay !== null) {
		emit(context, 'retrying', {
			id: job.id,
			attempt: job.attempt,
			delay,
			error,
		});
	}
	return reply;
}

/** What an aborted run does: a timeout fails the attempt; the other three leave the job alone. */
async function settleAborted<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	reason: QueueError,
): Promise<ClaimReply | undefined> {
	if (reason.code === 'TIMEOUT') {
		return await failAttempt(
			context,
			job,
			{ name: 'TIMEOUT', message: 'the attempt ran past its timeout' },
			backoffDelay(job.attempt, context.definition.backoff),
		);
	}
	if (reason.code === 'CANCELED') emit(context, 'canceled', { id: job.id });
	if (reason.code === 'LEASE_LOST') emit(context, 'error', reason);
	// CLOSED emits nothing: the lease is no longer renewed and lapses.
	return undefined;
}

async function runHandler<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	data: z.output<S>,
	run: Run,
): Promise<ClaimReply | undefined> {
	const { client, keys, definition } = context;
	emit(context, 'active', { id: job.id, attempt: job.attempt });
	const started = performance.now();
	const disarm = armTimeout(context, job);
	let outcome: Outcome;
	try {
		outcome = await raceAbort(run.controller.signal, () =>
			context.handler({
				id: job.id,
				data,
				attempt: job.attempt,
				attempts: job.attempts,
				signal: run.controller.signal,
				progress: progressOf(context, job, run.controller.signal),
				...stepsOf(context, job, run.controller.signal),
			}),
		);
	} finally {
		disarm();
	}
	if (outcome.kind === 'aborted') {
		return await settleAborted(context, job, outcome.reason);
	}
	if (outcome.kind === 'threw') {
		// A refused step value (R1, R3): never retried, recorded as the data and result refusals are.
		if (
			outcome.error instanceof QueueError &&
			outcome.error.code === 'INVALID'
		) {
			return await failAttempt(
				context,
				job,
				{
					name: 'QueueError',
					message: `INVALID: ${outcome.error.message}`,
				},
				null,
			);
		}
		return await failAttempt(
			context,
			job,
			toError(outcome.error),
			retryDelay(definition, job.attempt, outcome.error),
		);
	}
	const returned = outcome.value;
	let result: string | undefined;
	try {
		result = encodeResult(definition, returned, definition.name);
	} catch {
		// The thrown message holds zod issue codes: the stored error does not.
		return await failAttempt(
			context,
			job,
			{
				name: 'QueueError',
				message: 'INVALID: the result does not match the result schema',
			},
			null,
		);
	}
	const reply = await complete(
		client,
		keys,
		definition,
		job.id,
		job.token,
		result,
		context.open,
	);
	if (reply.settled) {
		emit(context, 'completed', {
			id: job.id,
			attempt: job.attempt,
			duration: performance.now() - started,
		});
	}
	return reply;
}

/**
 * Runs one job and settles it; answers the reply, whose job (if any) is the
 * slot's next, or `undefined` when the run was aborted and nothing settled.
 */
async function runJob<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
): Promise<ClaimReply | undefined> {
	const decoded = decodeData(context.definition, job.data);
	if (!decoded.ok) {
		// The schema changed under a waiting job: never run, never retried.
		return await failAttempt(
			context,
			job,
			{
				name: 'QueueError',
				message: 'INVALID: the stored data does not match the schema',
			},
			null,
		);
	}
	// Renewed until the settle is done, not just the handler: a slow settle
	// must not let the lease lapse under it.
	const run = beginRun(context, job);
	context.leases.add(job.id, job.token);
	try {
		return await runHandler(context, job, decoded.data, run);
	} finally {
		context.leases.delete(job.id, job.token);
		endRun(context, job);
	}
}

const NOTHING: ClaimReply = {
	jobs: [],
	stalled: [],
	failedInvalid: [],
	next: -1,
};

/** An aborted run settled nothing, so its slot claims its next job itself, unless the worker is closing. */
async function claimAfterAbort<S extends z.ZodType>(
	context: WorkerContext<S>,
): Promise<ClaimReply> {
	if (!context.open) return NOTHING;
	return await claim(context.client, context.keys, 1, context.definition.lease);
}

/** One slot: runs the job it was given and each one its settle claimed. */
export async function runSlot<S extends z.ZodType>(
	context: WorkerContext<S>,
	first: ClaimedJob,
): Promise<void> {
	let job: ClaimedJob | undefined = first;
	while (job) {
		try {
			const reply: ClaimReply =
				(await runJob(context, job)) ?? (await claimAfterAbort(context));
			announce(context, reply);
			job = reply.jobs[0];
			if (!job) markDrained(context, true);
		} catch (error) {
			// The job's lease lapses and another worker takes it back.
			emit(context, 'error', error);
			job = undefined;
		}
	}
}

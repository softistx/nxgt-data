import type { z } from 'zod';
import { decodeData } from '../encode';
import { claim } from '../scripts/claim';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
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
import {
	failAttempt,
	failThrown,
	settleAborted,
	settleReturned,
} from './settle-job';
import { stepsOf } from './steps';

async function runHandler<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	data: z.output<S>,
	run: Run,
): Promise<ClaimReply | undefined> {
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
		return await failThrown(context, job, outcome.error);
	}
	return await settleReturned(context, job, outcome.value, started);
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
			// Past the close's bound a claimed job is left to lapse.
			job = context.open ? reply.jobs[0] : undefined;
			if (!job) markDrained(context, true);
		} catch (error) {
			// The job's lease lapses and another worker takes it back.
			emit(context, 'error', error);
			job = undefined;
		}
	}
}

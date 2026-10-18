import type { z } from 'zod';
import { JobError } from '../../errors/job-error';
import { backoffDelay } from '../backoff';
import { decodeData, encodeResult } from '../encode';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
import { complete, fail } from '../scripts/settle';
import type { QueueDefinition } from '../types';
import type { WorkerContext } from './context';
import { announce, emit } from './events';
import { markDrained } from './idle';
import { progressOf } from './progress';

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

async function runHandler<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	data: z.output<S>,
): Promise<ClaimReply> {
	const { client, keys, definition } = context;
	emit(context, 'active', { id: job.id, attempt: job.attempt });
	const started = performance.now();
	let returned: unknown;
	try {
		returned = await context.handler({
			id: job.id,
			data,
			attempt: job.attempt,
			attempts: job.attempts,
			// Task 6 aborts it.
			signal: new AbortController().signal,
			progress: progressOf(context, job),
		});
	} catch (error) {
		return await failAttempt(
			context,
			job,
			toError(error),
			retryDelay(definition, job.attempt, error),
		);
	}
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

/** Runs one job and settles it; answers the reply, whose job (if any) is the slot's next. */
async function runJob<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
): Promise<ClaimReply> {
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
	context.leases.add(job.id, job.token);
	try {
		return await runHandler(context, job, decoded.data);
	} finally {
		context.leases.delete(job.id, job.token);
	}
}

/** One slot: runs the job it was given and each one its settle claimed. */
export async function runSlot<S extends z.ZodType>(
	context: WorkerContext<S>,
	first: ClaimedJob,
): Promise<void> {
	let job: ClaimedJob | undefined = first;
	while (job) {
		try {
			const reply: ClaimReply = await runJob(context, job);
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

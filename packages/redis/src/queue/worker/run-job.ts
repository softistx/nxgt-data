import type { z } from 'zod';
import { JobError } from '../../errors/job-error';
import { backoffDelay } from '../backoff';
import { decodeData } from '../encode';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
import { complete, fail } from '../scripts/settle';
import type { QueueDefinition } from '../types';
import type { WorkerContext } from './context';
import { emit } from './events';

function toError(thrown: unknown): { name: string; message: string } {
	return thrown instanceof Error
		? { name: thrown.name, message: thrown.message }
		: { name: 'Error', message: String(thrown) };
}

/** The wait before the next attempt, or null when the job must not be retried. */
function retryDelay(
	definition: QueueDefinition<z.ZodType>,
	attempt: number,
	error: unknown,
): number | null {
	if (!(error instanceof JobError)) {
		return backoffDelay(attempt, definition.backoff);
	}
	if (!error.retry) return null;
	return error.retryIn ?? backoffDelay(attempt, definition.backoff);
}

async function runHandler<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	data: z.output<S>,
): Promise<ClaimReply> {
	const { client, keys, definition } = context;
	let thrown: { error: unknown } | undefined;
	try {
		await context.handler({
			id: job.id,
			data,
			attempt: job.attempt,
			attempts: job.attempts,
		});
	} catch (error) {
		thrown = { error };
	}
	if (!thrown) {
		return await complete(
			client,
			keys,
			definition,
			job.id,
			job.token,
			context.open,
		);
	}
	const { error } = thrown;
	return await fail(
		client,
		keys,
		definition,
		job.id,
		job.token,
		toError(error),
		retryDelay(definition, job.attempt, error),
		context.open,
	);
}

/** Runs one job and settles it; answers the reply, whose job (if any) is the slot's next. */
async function runJob<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
): Promise<ClaimReply> {
	const { client, keys, definition } = context;
	const decoded = decodeData(definition, job.data);
	if (!decoded.ok) {
		// The schema changed under a waiting job: never run, never retried.
		return await fail(
			client,
			keys,
			definition,
			job.id,
			job.token,
			{
				name: 'QueueError',
				message: 'INVALID: the stored data does not match the schema',
			},
			null,
			context.open,
		);
	}
	// Renewed until the settle is done, not just the handler: a slow settle
	// must not let the lease lapse under it.
	context.leases.add(job.id, job.token);
	try {
		return await runHandler(context, job, decoded.data);
	} finally {
		context.leases.delete(job.id);
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
			job = reply.jobs[0];
		} catch (error) {
			// The job's lease lapses and another worker takes it back.
			emit(context, error);
			job = undefined;
		}
	}
}

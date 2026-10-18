import type { z } from 'zod';
import { JobError } from '../../errors/job-error';
import { QueueError } from '../../errors/queue-error';
import { backoffDelay } from '../backoff';
import { encodeResult } from '../encode';
import type { ClaimedJob, ClaimReply } from '../scripts/replies';
import { complete, fail } from '../scripts/settle';
import type { QueueDefinition } from '../types';
import type { WorkerContext } from './context';
import { emit } from './events';
import { isStepRefusal } from './step-refusal';

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
export async function failAttempt<S extends z.ZodType>(
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
export async function settleAborted<S extends z.ZodType>(
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

/** What a handler that threw does: a step's own refusal fails the job for good, any other error follows the retry rules. */
export async function failThrown<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	error: unknown,
): Promise<ClaimReply> {
	// A step's own refusal (R1, R3): never retried, recorded as the data and result refusals are.
	// Any other INVALID the handler threw is its own error and goes through the retry.
	if (error instanceof QueueError && isStepRefusal(error)) {
		return await failAttempt(
			context,
			job,
			{ name: 'QueueError', message: `INVALID: ${error.message}` },
			null,
		);
	}
	return await failAttempt(
		context,
		job,
		toError(error),
		retryDelay(context.definition, job.attempt, error),
	);
}

/** What a handler that returned does: encode the result and complete the job, or fail it INVALID. */
export async function settleReturned<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	returned: unknown,
	started: number,
): Promise<ClaimReply> {
	const { client, keys, definition } = context;
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

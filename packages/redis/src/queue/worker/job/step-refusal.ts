import type { QueueError } from '../../../errors/queue-error';

/** The `INVALID` errors a step raised itself, told apart from any other the handler threw. */
const refusals = new WeakSet<QueueError>();

/**
 * Marks `error` as a step's own refusal (a value it cannot store, or a stored
 * one its schema refuses): the job fails without retry.
 *
 * @returns `error`, to throw.
 */
export function markStepRefusal(error: QueueError): QueueError {
	refusals.add(error);
	return error;
}

/** Whether `error` is one a step raised and marked; an `INVALID` from the handler's own calls is not. */
export function isStepRefusal(error: unknown): boolean {
	return refusals.has(error as QueueError);
}

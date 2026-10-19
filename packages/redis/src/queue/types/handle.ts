import type { z } from 'zod';
import type { Duration } from '../duration';
import type { ResultOf } from './result';

/** What `add` hands back. */
export type JobHandle<R extends z.ZodType | undefined = undefined> = {
	readonly id: string;
	/** `true` when the id was already in the queue, so nothing was added. */
	readonly deduplicated: boolean;
	/**
	 * Resolves with the job's result once it completes. No deadline unless
	 * `timeout` is given; a `timeout` above about 24.8 days (2147483647 ms,
	 * the longest a timer waits) waits 24.8 days.
	 *
	 * A job that is not in the queue is `NOT_FOUND`: that includes one with
	 * `keepCompleted: false` that finished before the call, or during the wait
	 * with its event missed (it is deleted as it completes), and a canceled job
	 * whose event was missed (the cancel deletes it). An outcome published just
	 * as the call starts is heard, not read as absent.
	 *
	 * @throws QueueError `FAILED` when the job fails for good, `CANCELED` when
	 * it is canceled, `NOT_FOUND` when the job is not in the queue, `INVALID`
	 * when its result does not match the result schema, `WAIT_TIMEOUT` when
	 * `timeout` passes first.
	 * @throws TypeError for a malformed `timeout`.
	 */
	finished(options?: { timeout?: Duration }): Promise<ResultOf<R>>;
	/** Cancels the job: `true` when it was waiting, delayed or running, `false` when there was nothing to cancel. */
	cancel(): Promise<boolean>;
};

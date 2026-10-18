import { progress as store } from '../scripts/progress';
import type { ClaimedJob } from '../scripts/replies';
import type { WorkerContext } from './context';
import { emit } from './events';

/**
 * The `progress` function of one job's context: checks the value, stores it
 * under the job's token and tells the `progress` listeners. A job whose
 * token no longer holds, or whose run was aborted, stores and tells nothing.
 */
export function progressOf(
	context: WorkerContext,
	job: ClaimedJob,
	signal: AbortSignal,
): (value: number) => Promise<void> {
	return async (value) => {
		if (typeof value !== 'number' || !(value >= 0 && value <= 100)) {
			throw new TypeError(
				`progress on "${context.definition.name}": progress is a number from 0 to 100`,
			);
		}
		// Cut off (canceled, timed out, lost, closed): the token may still hold, the run is over.
		if (signal.aborted) return;
		const held = await store(
			context.client,
			context.keys,
			job.id,
			job.token,
			value,
		);
		if (held) emit(context, 'progress', { id: job.id, progress: value });
	};
}

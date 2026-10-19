import type { ClaimedJob } from '../scripts/claim/replies';
import { release } from '../scripts/release';
import type { WorkerContext } from './context';
import { emit } from './events';

/**
 * Gives back the jobs a claim took after `close` was called, which no
 * handler will start: one `RELEASE` for all of them, so each is `waiting`
 * again with its attempt and group slot returned, and the next worker runs
 * it at once instead of after a lapsed lease. Never rejects: a failure is
 * emitted on `'error'`, and those jobs lapse and are retaken as before.
 */
export async function giveBack(
	context: WorkerContext,
	jobs: readonly ClaimedJob[],
): Promise<void> {
	if (jobs.length === 0) return;
	try {
		await release(context.client, context.keys, context.definition, jobs);
	} catch (error) {
		emit(context, 'error', error);
	}
}

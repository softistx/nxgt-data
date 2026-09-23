import type { ResumeToken } from '@nxgt/mongo';
import type { SyncContext } from './context';
import { failed, SearchSyncError } from './errors';
import { open } from './follow';
import {
	acquire,
	type HeldLease,
	keepLease,
	leaseLost,
	release,
} from './lease';
import { reindexHeld } from './reindex';
import { checkIdle } from './running';
import { readState } from './state';
import type { RunningSearchSync } from './types';

/** The server no longer has the history a token points into. */
function historyLost(error: unknown): boolean {
	const code = (error as { serverCode?: number } | undefined)?.serverCode;
	return code === 286 || code === 280;
}

/**
 * Follows the collection from its recorded point — after a reindex when
 * nothing is recorded, or when the point is older than the server's history
 * and `onHistoryLost` allows it.
 */
export async function start(ctx: SyncContext): Promise<RunningSearchSync> {
	checkIdle(ctx, 'start it twice');
	// Before anything else, the first reindex included: two processes
	// starting at once would otherwise both reindex, and both follow.
	const lease = await acquire(ctx, 'start it');
	// Renewed while it reindexes, which can outlast `leaseMs`; the follower
	// renews it on its own once it is open.
	const stop = keepLease(ctx, lease, () => undefined);
	try {
		return await startHeld(ctx, lease);
	} catch (error) {
		await release(ctx, lease);
		throw error;
	} finally {
		stop();
	}
}

/** Reindexes holding the lease, and stops there if it was lost meanwhile. */
async function reindexKept(ctx: SyncContext, lease: HeldLease): Promise<void> {
	await reindexHeld(ctx);
	if (lease.lost) throw leaseLost(ctx);
}

async function startHeld(
	ctx: SyncContext,
	lease: HeldLease,
): Promise<RunningSearchSync> {
	let state = await readState(ctx);
	if (!state) {
		await reindexKept(ctx, lease);
		state = await readState(ctx);
	}
	try {
		return await open(
			ctx,
			(state as { resumeToken: ResumeToken }).resumeToken,
			lease,
		);
	} catch (error) {
		if (!historyLost(error)) throw failed(ctx.name, 'starting', error);
		if (ctx.onHistoryLost === 'fail') {
			throw new SearchSyncError(
				`Search sync "${ctx.name}" was last at a point the server's change ` +
					'history no longer reaches. Reindex it, or start it with ' +
					"onHistoryLost: 'reindex'.",
				{ code: 'HISTORY_LOST', sync: ctx.name, cause: error },
			);
		}
		await reindexKept(ctx, lease);
		const fresh = (await readState(ctx)) as { resumeToken: ResumeToken };
		try {
			return await open(ctx, fresh.resumeToken, lease);
		} catch (again) {
			throw failed(ctx.name, 'starting', again);
		}
	}
}

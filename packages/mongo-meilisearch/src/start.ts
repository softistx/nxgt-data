import type { ResumeToken } from '@nxgt/mongo';
import type { SyncContext } from './context';
import { failed, SearchSyncError } from './errors';
import { open } from './follow';
import {
	acquire,
	confirmLease,
	type HeldLease,
	keepLease,
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
		const running = await startHeld(ctx, lease);
		stop();
		return running;
	} catch (error) {
		stop();
		await release(ctx, lease);
		throw error;
	}
}

/** Opens the follower, once the server confirms the lease is still held. */
async function openHeld(
	ctx: SyncContext,
	token: ResumeToken,
	lease: HeldLease,
): Promise<RunningSearchSync> {
	await confirmLease(ctx, lease);
	return open(ctx, token, lease);
}

async function startHeld(
	ctx: SyncContext,
	lease: HeldLease,
): Promise<RunningSearchSync> {
	let state = await readState(ctx);
	if (!state) {
		await reindexHeld(ctx, lease);
		state = await readState(ctx);
	}
	try {
		return await openHeld(
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
		await reindexHeld(ctx, lease);
		const fresh = (await readState(ctx)) as { resumeToken: ResumeToken };
		try {
			return await openHeld(ctx, fresh.resumeToken, lease);
		} catch (again) {
			throw failed(ctx.name, 'starting', again);
		}
	}
}

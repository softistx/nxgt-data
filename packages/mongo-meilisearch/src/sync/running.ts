import type { SyncContext } from './context';
import { SearchSyncError } from './errors';

/**
 * Refuses to do beside a running follower what would undo its work: a
 * reindex removes what the follower has just indexed, and the follower,
 * having handled that change, never sends it again.
 *
 * Its `RUNNING` carries no `holder` and no `expiresAt`: the lease is this
 * process's own and renewed for as long as it follows, so there is no time to
 * wait for — only a `close()` frees the name.
 */
export function checkIdle(ctx: SyncContext, doing: string): void {
	if (!ctx.follower.running) return;
	throw new SearchSyncError(
		`Search sync "${ctx.name}" is already following changes in this ` +
			`process: close it before you ${doing}.`,
		{ code: 'RUNNING', sync: ctx.name },
	);
}

import type { ResumeToken } from '@nxgt/mongo';
import type { SyncContext } from './context';
import { failed } from './errors';
import type { SearchSyncState } from './types';

/** What the sync has recorded, or `undefined` before its first reindex. */
export async function readState(
	ctx: SyncContext,
): Promise<SearchSyncState | undefined> {
	try {
		return (await ctx.state.findOne({ _id: ctx.name })) ?? undefined;
	} catch (error) {
		throw failed(ctx.name, 'reading its resume point', error);
	}
}

/** Forgets everything recorded: the next `start` reindexes. */
export async function clearState(ctx: SyncContext): Promise<void> {
	try {
		await ctx.state.deleteOne({ _id: ctx.name });
	} catch (error) {
		throw failed(ctx.name, 'forgetting its resume point', error);
	}
}

/** Moves the resume point, and says a reindex finished when one did. */
export async function saveState(
	ctx: SyncContext,
	resumeToken: ResumeToken,
	reindexed: boolean,
): Promise<void> {
	const now = new Date();
	try {
		await ctx.state.updateOne(
			{ _id: ctx.name },
			{
				$set: {
					resumeToken,
					updatedAt: now,
					...(reindexed ? { reindexedAt: now } : {}),
				},
			},
			{ upsert: true },
		);
	} catch (error) {
		throw failed(ctx.name, 'recording its resume point', error);
	}
}

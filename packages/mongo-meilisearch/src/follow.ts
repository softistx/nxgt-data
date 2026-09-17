import type {
	AnyCollectionDefinition,
	ChangeOf,
	ChangeSubscription,
	ResumeToken,
} from '@nxgt/mongo';
import { send } from './batch';
import type { Doc, SyncContext } from './context';
import { type Entry, entryOf } from './documents';
import { failed, SearchSyncError } from './errors';
import { reindex } from './reindex';
import { checkIdle } from './running';
import { clearState, readState, saveState } from './state';
import type { RunningSearchSync } from './types';

/** The server no longer has the history a token points into. */
function historyLost(error: unknown): boolean {
	const code = (error as { serverCode?: number } | undefined)?.serverCode;
	return code === 286 || code === 280;
}

/** What a running sync holds between changes. */
interface Following {
	readonly pending: Map<string, Entry>;
	/** The token of the last change in `pending`. */
	last: ResumeToken | undefined;
	saved: ResumeToken;
	/** Changes whose handler has not queued them yet. */
	inFlight: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Records where the stream is while nothing is being sent. */
	beat: ReturnType<typeof setInterval> | undefined;
	/** Flushes run one after the other. */
	chain: Promise<void>;
	/** The stream has stopped: what is queued no longer records anything. */
	done: boolean;
	failure: SearchSyncError | undefined;
}

/**
 * Sends what is pending, then records the token that covers it — or, with
 * nothing to send and no change being handled, where the stream is: a quiet
 * collection would otherwise keep a resume point until the server's history
 * no longer reaches it.
 */
function flush(
	ctx: SyncContext,
	f: Following,
	subscription: ChangeSubscription,
): Promise<void> {
	f.chain = f.chain.then(async () => {
		if (f.failure) throw f.failure;
		if (f.done) return;
		clearTimeout(f.timer);
		f.timer = undefined;
		const entries = [...f.pending.values()];
		const upTo = f.last;
		f.pending.clear();
		try {
			if (entries.length > 0) await send(ctx, entries);
			const idle = entries.length === 0 && f.inFlight === 0;
			const at = upTo ?? (idle ? subscription.position : undefined);
			if (at && at !== f.saved) {
				await saveState(ctx, at, false);
				f.saved = at;
			}
		} catch (error) {
			f.failure ??= failed(ctx.name, 'sending changes', error);
			throw f.failure;
		}
	});
	return f.chain;
}

async function open(
	ctx: SyncContext,
	token: ResumeToken,
): Promise<RunningSearchSync> {
	const f: Following = {
		pending: new Map(),
		last: undefined,
		saved: token,
		inFlight: 0,
		timer: undefined,
		beat: undefined,
		chain: Promise.resolve(),
		done: false,
		failure: undefined,
	};
	const handle = async (change: ChangeOf<AnyCollectionDefinition>) => {
		if (f.failure) throw f.failure;
		f.inFlight += 1;
		let entry: Entry;
		try {
			const document =
				change.type === 'delete' ? undefined : (change.document as Doc);
			entry = await entryOf(ctx, change.id, document);
		} catch (error) {
			// Kept, so `flush` and `close` report it as `closed` does.
			f.failure = failed(ctx.name, 'following changes', error);
			throw f.failure;
		} finally {
			f.inFlight -= 1;
		}
		f.pending.set(entry.key, entry);
		f.last = change.resumeToken;
		if (f.pending.size >= ctx.batchSize) {
			await flush(ctx, f, subscription);
		} else if (!f.timer) {
			f.timer = setTimeout(() => {
				flush(ctx, f, subscription).catch(() => subscription.close());
			}, ctx.flushIntervalMs);
		}
	};
	const subscription = ctx.collection.onChange(handle, { startAfter: token });
	f.beat = setInterval(() => {
		flush(ctx, f, subscription).catch(() => subscription.close());
	}, ctx.positionIntervalMs);
	const stop = () => {
		f.done = true;
		clearTimeout(f.timer);
		clearInterval(f.beat);
		ctx.follower.running = false;
	};
	const closed = subscription.closed.then(
		async (reason) => {
			stop();
			// A flush the timer or the beat had queued would otherwise record a
			// point after this.
			await f.chain.catch(() => undefined);
			if (f.failure) throw f.failure;
			// The collection is gone, and so is the point the stream stopped at:
			// what is recorded is older, and every later start would stop here
			// again. Forgetting it makes the next one reindex.
			if (reason === 'invalidated') await clearState(ctx);
			return reason;
		},
		(error: unknown) => {
			stop();
			throw f.failure ?? failed(ctx.name, 'following changes', error);
		},
	);
	try {
		await subscription.ready;
	} catch (error) {
		stop();
		closed.catch(() => undefined);
		throw error;
	}
	ctx.follower.running = true;
	const close = async () => {
		try {
			await flush(ctx, f, subscription);
		} finally {
			await subscription.close();
		}
	};
	return {
		ready: subscription.ready,
		closed,
		flush: () => flush(ctx, f, subscription),
		close,
		[Symbol.asyncDispose]: close,
	};
}

/**
 * Follows the collection from its recorded point — after a reindex when
 * nothing is recorded, or when the point is older than the server's history
 * and `onHistoryLost` allows it.
 */
export async function start(ctx: SyncContext): Promise<RunningSearchSync> {
	checkIdle(ctx, 'start it twice');
	let state = await readState(ctx);
	if (!state) {
		await reindex(ctx);
		state = await readState(ctx);
	}
	try {
		return await open(ctx, (state as { resumeToken: ResumeToken }).resumeToken);
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
		await reindex(ctx);
		const fresh = (await readState(ctx)) as { resumeToken: ResumeToken };
		try {
			return await open(ctx, fresh.resumeToken);
		} catch (again) {
			throw failed(ctx.name, 'starting', again);
		}
	}
}

import type {
	AnyCollectionDefinition,
	ChangeOf,
	ChangeSubscription,
	CloseReason,
	ResumeToken,
} from '@nxgt/mongo';
import { send } from './batch';
import type { Doc, SyncContext } from './context';
import { type Entry, entryOf } from './documents';
import { failed, type SearchSyncError } from './errors';
import { type HeldLease, keepLease, leaseLost, release } from './lease';
import { clearState, saveState } from './state';
import type { RunningSearchSync } from './types';

const noop = () => undefined;

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
	/** Stops renewing the lease on the sync's name. */
	stopLease: () => void;
	/**
	 * The stream was heard. Only then does `closed` let go of the lease: a
	 * stream that never got ready leaves it to `start`, which may reindex and
	 * open again on it after a lost history.
	 */
	heard: boolean;
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

/** A sync that has not heard anything yet, from `token`. */
function following(token: ResumeToken): Following {
	return {
		pending: new Map(),
		last: undefined,
		saved: token,
		inFlight: 0,
		timer: undefined,
		beat: undefined,
		stopLease: noop,
		heard: false,
		chain: Promise.resolve(),
		done: false,
		failure: undefined,
	};
}

/** Stops everything a running sync does on its own. */
function stopFollowing(ctx: SyncContext, f: Following): void {
	f.done = true;
	clearTimeout(f.timer);
	clearInterval(f.beat);
	f.stopLease();
	ctx.follower.running = false;
}

/**
 * What `closed` settles to once the stream stops: the reason, or the failure
 * that stopped it — after the last queued flush, and with the lease let go.
 */
function settle(
	ctx: SyncContext,
	f: Following,
	subscription: ChangeSubscription,
	lease: HeldLease,
): Promise<CloseReason> {
	const letGo = () => (f.heard ? release(ctx, lease) : Promise.resolve());
	return subscription.closed.then(
		async (reason) => {
			stopFollowing(ctx, f);
			try {
				// A flush the timer or the beat had queued would otherwise record
				// a point after this.
				await f.chain.catch(noop);
				if (f.failure) throw f.failure;
				// The collection is gone, and so is the point the stream stopped
				// at: what is recorded is older, and every later start would stop
				// here again. Forgetting it makes the next one reindex.
				if (reason === 'invalidated') await clearState(ctx);
				return reason;
			} finally {
				await letGo();
			}
		},
		async (error: unknown) => {
			stopFollowing(ctx, f);
			await letGo();
			throw f.failure ?? failed(ctx.name, 'following changes', error);
		},
	);
}

export async function open(
	ctx: SyncContext,
	token: ResumeToken,
	lease: HeldLease,
): Promise<RunningSearchSync> {
	const f = following(token);
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
	// A lease found gone means another process may be following this name:
	// stop at once, before anything else is sent or recorded beside it.
	f.stopLease = keepLease(ctx, lease, () => {
		if (f.failure) return;
		f.failure = leaseLost(ctx);
		void subscription.close();
	});
	const closed = settle(ctx, f, subscription, lease);
	try {
		await subscription.ready;
	} catch (error) {
		stopFollowing(ctx, f);
		closed.catch(noop);
		throw error;
	}
	f.heard = true;
	ctx.follower.running = true;
	const close = async () => {
		try {
			await flush(ctx, f, subscription);
		} finally {
			await subscription.close();
			// The lease is let go in `closed`'s handler: waited for, so a
			// `reindex` or a `start` right after this finds the name free. Not
			// from inside a change being handled, which `closed` waits for.
			if (f.inFlight === 0) await closed.then(noop, noop);
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

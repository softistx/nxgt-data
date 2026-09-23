import { hostname } from 'node:os';
import { ObjectId } from 'mongodb';
import type { SyncContext } from './context';
import { failed, SearchSyncError } from './errors';

/**
 * The lease on a sync's name: one document in the state collection, whose
 * `_id` is `{ lease: <name> }` — an object, so it can never be a sync's own
 * state, whose `_id` is the name itself.
 *
 * Taking it is one atomic write whose update decides — the server, not a
 * read before a write. Every time is the server's (`$$NOW`), so hosts whose
 * clocks disagree still agree on when a lease lapses.
 *
 * Renewal, release and the holder's name follow `@nxgt/mongo`'s migration
 * lock (`migrations/lock.ts`); taking it does not — see `take`.
 */
export interface LeaseDocument {
	_id: { lease: string };
	holder: string;
	acquiredAt: Date;
	expiresAt: Date;
}

/** A held lease: data, and whether a renewal found it gone. */
export interface HeldLease {
	readonly holder: string;
	lost: boolean;
}

const idOf = (ctx: SyncContext) => ({ lease: ctx.name });

/**
 * Inserts the lease, or takes over one that lapsed, in one atomic upsert.
 *
 * The filter is `_id` alone — the server allows no `$expr` in an upsert's
 * filter — and the decision is made by the update instead: a pipeline that
 * keeps the current holder's fields while its lease runs, and writes this
 * holder's when there is none or it lapsed. What comes back says who won.
 * It is a `findAndModify`, not an `aggregate`: `@nxgt/mongo`'s migration lock
 * takes its lock with `$documents`/`$merge`, which a failpoint or a monitor
 * aimed at the change stream's `aggregate` would also catch.
 */
async function take(ctx: SyncContext, holder: string): Promise<boolean> {
	const free = {
		$or: [
			{ $eq: [{ $type: '$expiresAt' }, 'missing'] },
			{ $lte: ['$expiresAt', '$$NOW'] },
		],
	};
	const pick = (mine: unknown, theirs: string) => ({
		$cond: [free, mine, theirs],
	});
	try {
		const after = await ctx.leases.findOneAndUpdate(
			{ _id: idOf(ctx) },
			[
				{
					$set: {
						holder: pick({ $literal: holder }, '$holder'),
						acquiredAt: pick('$$NOW', '$acquiredAt'),
						expiresAt: pick({ $add: ['$$NOW', ctx.leaseMs] }, '$expiresAt'),
					},
				},
			],
			{ upsert: true, returnDocument: 'after' },
		);
		return after?.holder === holder;
	} catch (error) {
		// Two upserts racing to insert the same `_id`: the other one won.
		if ((error as { code?: number }).code === 11000) return false;
		throw error;
	}
}

/**
 * Takes the lease, or throws `RUNNING` naming who holds it and until when —
 * the same code a second `start` in this process gets, since it means the
 * same thing: this name is being followed.
 */
export async function acquire(
	ctx: SyncContext,
	doing: string,
): Promise<HeldLease> {
	const holder = `${hostname()}:${process.pid}:${new ObjectId().toHexString()}`;
	let current: LeaseDocument | null = null;
	try {
		// Twice at most: a holder that let go between the take and the read
		// left the name free, and refusing it then would be wrong.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (await take(ctx, holder)) return { holder, lost: false };
			current = await ctx.leases.findOne({ _id: idOf(ctx) });
			if (current) break;
		}
	} catch (error) {
		throw failed(ctx.name, 'taking its lease', error);
	}
	const until =
		current?.expiresAt instanceof Date
			? current.expiresAt.toISOString()
			: 'it lets go';
	throw new SearchSyncError(
		`Search sync "${ctx.name}" is held by ${current?.holder ?? 'another process'} ` +
			`until ${until}: ` +
			`wait for it to close, or for its lease to lapse, before you ${doing}.`,
		{ code: 'RUNNING', sync: ctx.name },
	);
}

/**
 * Pushes the lease's end back by `leaseMs`. A renewal that finds another
 * holder marks the lease lost; one that does not reach the server is tried
 * again at the next beat, and the lease lapses only if none reaches it for a
 * whole `leaseMs`.
 */
export async function renew(ctx: SyncContext, lease: HeldLease): Promise<void> {
	try {
		const result = await ctx.leases.updateOne(
			{ _id: idOf(ctx), holder: lease.holder },
			[{ $set: { expiresAt: { $add: ['$$NOW', ctx.leaseMs] } } }],
		);
		if (result.matchedCount === 0) lease.lost = true;
	} catch {
		// Tried again at the next beat.
	}
}

/**
 * Renews the lease now, and throws `LEASE_LOST` if it is someone else's: the
 * check before a step that must not run beside another holder.
 */
export async function confirmLease(
	ctx: SyncContext,
	lease: HeldLease,
): Promise<void> {
	let result: { matchedCount: number };
	try {
		result = await ctx.leases.updateOne(
			{ _id: idOf(ctx), holder: lease.holder },
			[{ $set: { expiresAt: { $add: ['$$NOW', ctx.leaseMs] } } }],
		);
	} catch (error) {
		// Unlike a timed renewal, not tried again later: what comes next must
		// not run on a lease nobody could confirm.
		throw failed(ctx.name, 'checking its lease', error);
	}
	if (result.matchedCount === 0) lease.lost = true;
	if (lease.lost) throw leaseLost(ctx);
}

/** Lets go of it, if it is still this holder's. One that fails lapses. */
export async function release(
	ctx: SyncContext,
	lease: HeldLease,
): Promise<void> {
	await ctx.leases
		.deleteOne({ _id: idOf(ctx), holder: lease.holder })
		.catch(() => undefined);
}

/** The error a sync stops with once its lease is someone else's. */
export function leaseLost(ctx: SyncContext): SearchSyncError {
	return new SearchSyncError(
		`Search sync "${ctx.name}" lost its lease: another process holds the ` +
			'name now, or the lease was removed (it lapses when not renewed ' +
			`within ${ctx.leaseMs} ms). It stopped rather than run beside it.`,
		{ code: 'LEASE_LOST', sync: ctx.name },
	);
}

/**
 * Renews the lease every third of `leaseMs`, and calls `onLost` once when a
 * renewal finds it someone else's. Gives back what stops the renewals.
 */
export function keepLease(
	ctx: SyncContext,
	lease: HeldLease,
	onLost: () => void,
): () => void {
	let stopped = false;
	const beat = setInterval(
		() => {
			void renew(ctx, lease).then(() => {
				// A renewal still in flight when it was stopped reports nothing.
				if (lease.lost && !stopped) {
					clearInterval(beat);
					onLost();
				}
			});
		},
		Math.max(1, Math.floor(ctx.leaseMs / 3)),
	);
	return () => {
		stopped = true;
		clearInterval(beat);
	};
}

/**
 * Runs `fn` holding the lease, renewed every third of `leaseMs`. `fn` checks
 * it is still held where that matters (`confirmLease`).
 */
export async function withLease<T>(
	ctx: SyncContext,
	doing: string,
	fn: (lease: HeldLease) => Promise<T>,
): Promise<T> {
	const lease = await acquire(ctx, doing);
	const stop = keepLease(ctx, lease, () => undefined);
	try {
		return await fn(lease);
	} finally {
		stop();
		await release(ctx, lease);
	}
}

import { hostname } from 'node:os';
import { ObjectId } from 'mongodb';
import { MigrationLockedError } from './errors';
import { driver, type MigrationStore } from './store';

/**
 * The lock two runs share: one document, `_id: 'lock'`, in its own
 * collection. Taking it is an upsert that matches only an expired lock, so a
 * held one makes the insert collide on `_id` — the server decides, not a read
 * before a write. The holder renews it while it works; one that crashed
 * blocks the next run for `lockTtlMs` at most.
 *
 * Every time is the server's (`$$NOW`), so hosts whose clocks disagree still
 * agree on when a lock lapses.
 */

interface LockDocument {
	_id: 'lock';
	holder: string;
	acquiredAt: Date;
	expiresAt: Date;
}

/** A held lock: data, and whether a renewal found it gone. */
export interface HeldLock {
	readonly holder: string;
	lost: boolean;
}

const lockOf = (store: MigrationStore) =>
	store.db.collection<LockDocument>(store.lockName);

/** The fields a taken lock has, all timed by the server. */
function stamped(store: MigrationStore, holder: string) {
	return {
		holder: { $literal: holder },
		acquiredAt: '$$NOW',
		expiresAt: { $add: ['$$NOW', store.lockTtlMs] },
	};
}

/**
 * Takes the lock: inserts it, or, when one is there, takes it over only if
 * it has lapsed. Each step is one atomic write — an upsert cannot do both,
 * as the server allows no `$expr` in an upsert's filter.
 */
async function take(store: MigrationStore, holder: string): Promise<boolean> {
	const inserted = await store.db
		.aggregate([
			{ $documents: [{ _id: 'lock', ...stamped(store, holder) }] },
			{
				$merge: {
					into: store.lockName,
					whenMatched: 'fail',
					whenNotMatched: 'insert',
				},
			},
		])
		.toArray()
		.then(
			() => true,
			(error: { code?: number }) => {
				if (error.code !== 11000) throw error;
				return false;
			},
		);
	if (inserted) return true;
	const lapsed = await lockOf(store).updateOne(
		{ _id: 'lock', $expr: { $lte: ['$expiresAt', '$$NOW'] } },
		[{ $set: stamped(store, holder) }],
	);
	return lapsed.modifiedCount === 1;
}

async function acquire(store: MigrationStore): Promise<HeldLock> {
	const holder = `${hostname()}:${process.pid}:${new ObjectId().toHexString()}`;
	const taken = await driver(store, () => take(store, holder), store.lockName);
	if (taken) return { holder, lost: false };
	const current = await driver(
		store,
		() => lockOf(store).findOne({ _id: 'lock' }),
		store.lockName,
	);
	throw new MigrationLockedError(
		`Migrations are locked by ${current?.holder ?? 'another run'} until ` +
			`${current?.expiresAt.toISOString() ?? 'it releases them'}`,
		{
			collection: store.lockName,
			holder: current?.holder,
			expiresAt: current?.expiresAt,
		},
	);
}

async function renew(store: MigrationStore, lock: HeldLock): Promise<void> {
	try {
		const result = await lockOf(store).updateOne(
			{ _id: 'lock', holder: lock.holder },
			[{ $set: { expiresAt: { $add: ['$$NOW', store.lockTtlMs] } } }],
		);
		if (result.matchedCount === 0) lock.lost = true;
	} catch {
		// A renewal that did not reach the server is retried at the next beat;
		// the lock lapses only if none reaches it for a whole TTL.
	}
}

/** Refuses to go on once the lock is someone else's. */
export function checkLock(store: MigrationStore, lock: HeldLock): void {
	if (lock.lost) {
		throw new MigrationLockedError(
			'This run lost its migration lock: it was not renewed in time, and ' +
				'another run may have taken it. Nothing more was run.',
			{ collection: store.lockName, holder: lock.holder },
		);
	}
}

/** Runs `fn` holding the lock, renewed every third of its TTL. */
export async function withLock<T>(
	store: MigrationStore,
	fn: (lock: HeldLock) => Promise<T>,
): Promise<T> {
	const lock = await acquire(store);
	const beat = setInterval(
		() => {
			void renew(store, lock);
		},
		Math.floor(store.lockTtlMs / 3),
	);
	try {
		return await fn(lock);
	} finally {
		clearInterval(beat);
		await lockOf(store)
			.deleteOne({ _id: 'lock', holder: lock.holder })
			.catch(() => {
				// Not released, it lapses after its TTL.
			});
	}
}

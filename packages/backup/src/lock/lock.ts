import { join } from 'node:path';
import type { BackupContext } from '../backups/context';
import { BackupError } from '../errors/backup-error';
import { upTo } from '../files/streams';
import { isBackupId, newBackupId } from '../format/ids';
import type { Repository } from '../repository/types';

export const LOCK_FORMAT = 'nxgt-backup-lock/1';
export const LOCKS = 'locks';

/** The largest lock file read: a few hundred bytes are written. */
const LOCK_MAX_BYTES = 4096;

/** What a writer holding a definition's lock in one repository writes there. */
export interface LockRecord {
	format: typeof LOCK_FORMAT;
	/** Its own id, which is also its key: `<backup>/locks/<id>.json`. */
	id: string;
	/** What holds it. */
	operation: 'create' | 'prune';
	/** When the lease ends unless renewed, as an ISO date, by the holder's clock. */
	expiresAt: string;
}

/** One repository's lock, held: renewed in the background until released. */
export interface Lease {
	readonly repository: Repository;
	/** Whether the lease is still sure to be held: renewed before it ran out. */
	held(): boolean;
	/** Stops renewing and removes the lock. Never rejects. */
	release(): Promise<void>;
}

export function readLock(text: string): LockRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const expiresAt = record['expiresAt'];
	if (
		record['format'] !== LOCK_FORMAT ||
		!isBackupId(record['id']) ||
		(record['operation'] !== 'create' && record['operation'] !== 'prune') ||
		typeof expiresAt !== 'string' ||
		Number.isNaN(Date.parse(expiresAt))
	) {
		return undefined;
	}
	return {
		format: LOCK_FORMAT,
		id: record['id'] as string,
		operation: record['operation'],
		expiresAt,
	};
}

function lockKey(ctx: BackupContext, id: string): string {
	return `${ctx.backup}/${LOCKS}/${id}.json`;
}

/** Removes `key`, whatever the repository does — even a `delete` that throws. */
async function forget(repository: Repository, key: string): Promise<void> {
	await Promise.resolve()
		.then(() => repository.delete(key))
		.catch(() => undefined);
}

/**
 * Whether another writer may still hold the lock at `key`. A lock that does
 * not read as one is held: nothing says when it ends, and guessing wrong
 * lets two writers in. One past its `expiresAt` by a whole lease more —
 * room for the two clocks to disagree — is not: its holder stopped at
 * `expiresAt`, since it could not renew.
 */
async function stillHeld(
	ctx: BackupContext,
	repository: Repository,
	key: string,
	now: number,
): Promise<boolean> {
	const stream = await repository.get(key);
	if (!stream) return false;
	const record = readLock(
		new TextDecoder().decode(await upTo(stream, LOCK_MAX_BYTES)),
	);
	if (!record) return true;
	if (Date.parse(record.expiresAt) + ctx.lease >= now) return true;
	await forget(repository, key);
	return false;
}

async function writeLock(
	ctx: BackupContext,
	repository: Repository,
	folder: string,
	record: LockRecord,
): Promise<void> {
	const file = join(folder, `${record.id}.lock.json`);
	await Bun.write(file, `${JSON.stringify(record)}\n`);
	await repository.put(lockKey(ctx, record.id), file);
}

/**
 * Takes the definition's lock in `repository`, or throws `LOCKED`.
 *
 * The lock is a file of its own, written **before** looking for others:
 * a writer that then finds any other live lock removes its own and gives
 * up. Two writers can both give up — never both go on, since each looks
 * only after its own lock is there. That needs no conditional write, only a
 * listing that shows a key as soon as its `put` resolved — what a local
 * folder and AWS S3 do, and what a store must do for the lock to hold.
 */
export async function acquireLock(
	ctx: BackupContext,
	repository: Repository,
	operation: LockRecord['operation'],
	folder: string,
	call: string,
): Promise<Lease> {
	const record: LockRecord = {
		format: LOCK_FORMAT,
		id: newBackupId(new Date()),
		operation,
		expiresAt: new Date(Date.now() + ctx.lease).toISOString(),
	};
	// The deadline the holder keeps is its own monotonic clock's, read before
	// the write begins: a wall clock stepped back would stretch it.
	const deadline = performance.now() + ctx.lease;
	const own = lockKey(ctx, record.id);
	try {
		// Inside the try: a put that rejected after it landed still leaves a
		// lock behind, which would hold every writer off for two leases.
		await writeLock(ctx, repository, folder, record);
		await refuseOthers(ctx, repository, own, call);
	} catch (error) {
		await forget(repository, own);
		throw error;
	}
	return renewing(ctx, repository, folder, record, deadline);
}

async function refuseOthers(
	ctx: BackupContext,
	repository: Repository,
	own: string,
	call: string,
): Promise<void> {
	const now = Date.now();
	for await (const key of repository.list(`${ctx.backup}/${LOCKS}/`)) {
		if (key === own || !key.endsWith('.json')) continue;
		if (await stillHeld(ctx, repository, key, now)) {
			throw new BackupError(
				`${call} on "${ctx.backup}": another create or prune holds the lock ` +
					`(repository "${repository.name}")`,
				{ code: 'LOCKED', backup: ctx.backup, repository: repository.name },
			);
		}
	}
}

/**
 * The lease, renewed every third of it. A renewal that fails is not
 * retried early: the lease simply runs out, and `held()` says so from the
 * moment it does — before any other writer may take the lock. Once out it
 * stays out, and nothing more is written: a slow renewal that lands after
 * the end does not bring it back, since another writer may have found the
 * lock stale by then and taken its own.
 */
function renewing(
	ctx: BackupContext,
	repository: Repository,
	folder: string,
	record: LockRecord,
	firstDeadline: number,
): Lease {
	let deadline = firstDeadline;
	let lost = false;
	let renewal: Promise<void> | undefined;
	const held = (): boolean => {
		if (!lost && performance.now() >= deadline) {
			lost = true;
			clearInterval(timer);
		}
		return !lost;
	};
	const timer = setInterval(() => {
		// One renewal at a time: a slow store is not given a second write
		// racing the first for the same staged file.
		if (renewal || !held()) return;
		const next = performance.now() + ctx.lease;
		renewal = writeLock(ctx, repository, folder, {
			...record,
			expiresAt: new Date(Date.now() + ctx.lease).toISOString(),
		})
			.then(
				() => {
					if (held()) deadline = Math.max(deadline, next);
				},
				() => undefined,
			)
			.finally(() => {
				renewal = undefined;
			});
	}, ctx.lease / 3);
	timer.unref();
	return {
		repository,
		held,
		release: async () => {
			clearInterval(timer);
			await renewal;
			await forget(repository, lockKey(ctx, record.id));
		},
	};
}

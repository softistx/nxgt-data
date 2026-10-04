import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupContext } from '../backups/context';
import { BackupError } from '../errors/backup-error';
import type { Repository } from '../repository/types';
import { acquireLock, type Lease, type LockRecord } from './lock';

/**
 * Takes the lock in every repository at once. One that refuses — held
 * elsewhere, or out of reach — is recorded in `failed` and left out; the
 * others are locked, and their leases returned by name.
 */
export async function lockAll(
	ctx: BackupContext,
	operation: LockRecord['operation'],
	folder: string,
	failed: Map<string, unknown>,
): Promise<Map<string, Lease>> {
	const leases = new Map<string, Lease>();
	await Promise.all(
		ctx.repositories.map(async (repository) => {
			try {
				leases.set(
					repository.name,
					await acquireLock(ctx, repository, operation, folder, operation),
				);
			} catch (error) {
				failed.set(repository.name, error);
			}
		}),
	);
	return leases;
}

/** Releases every lease; never rejects, whatever a repository does. */
export async function releaseAll(leases: Map<string, Lease>): Promise<void> {
	await Promise.allSettled(
		[...leases.values()].map((lease) => lease.release()),
	);
}

/** Why nothing more goes to a repository whose lease ran out. */
export function leaseLost(
	ctx: BackupContext,
	call: string,
	id: string,
	repository: string,
): BackupError {
	return new BackupError(
		`${call} on "${ctx.backup}": the lock's lease ran out before it was done ` +
			`(repository "${repository}")`,
		{ code: 'LEASE_LOST', backup: ctx.backup, id, repository },
	);
}

/**
 * Runs `work` holding the lock in one repository, and releases it after,
 * whatever `work` did. The lock's staging folder is removed with it.
 */
export async function withLock<T>(
	ctx: BackupContext,
	repository: Repository,
	operation: LockRecord['operation'],
	call: string,
	work: (lease: Lease) => Promise<T>,
): Promise<T> {
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-backup-lock-'));
	try {
		const lease = await acquireLock(ctx, repository, operation, folder, call);
		try {
			return await work(lease);
		} finally {
			await lease.release();
		}
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

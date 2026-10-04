import { type BackupContext, repositoryOf } from '../backups/context';
import { type At, fetchManifest } from '../backups/read';
import { BackupError } from '../errors/backup-error';
import { isBackupId } from '../format/ids';
import { leaseLost, withLock } from '../lock/run-locks';
import type { Repository } from '../repository/types';

export const HOLDS = 'holds';
export const HOLD_FORMAT = 'nxgt-backup-hold/1';

export interface HoldOptions {
	/** One repository, by name. Every repository by default. */
	from?: string | undefined;
}

/** Where `hold` or `unhold` acted. */
export interface HoldResult {
	id: string;
	/** The repositories it was done in. */
	repositories: string[];
}

/** The key of a backup's hold: `<backup>/holds/<id>.json`. */
function holdKey(ctx: BackupContext, id: string): string {
	return `${ctx.backup}/${HOLDS}/${id}.json`;
}

/** The ids held in `repository`, read from the keys alone. */
export async function heldIds(
	ctx: BackupContext,
	repository: Repository,
): Promise<Set<string>> {
	const prefix = `${ctx.backup}/${HOLDS}/`;
	const held = new Set<string>();
	for await (const key of repository.list(prefix)) {
		const name = key.slice(prefix.length);
		if (name.endsWith('.json') && !name.includes('/')) {
			held.add(name.slice(0, -'.json'.length));
		}
	}
	return held;
}

function targets(
	ctx: BackupContext,
	id: string,
	from: string | undefined,
	call: string,
): readonly Repository[] {
	if (!isBackupId(id)) {
		throw new TypeError(
			`${call} on "${ctx.backup}": the id is not a backup id`,
		);
	}
	return from === undefined
		? ctx.repositories
		: [repositoryOf(ctx, from, call)];
}

/** Holds `id` in one repository; `false` when the backup is not there. */
async function holdIn(
	ctx: BackupContext,
	repository: Repository,
	id: string,
): Promise<boolean> {
	// The lock's record says `prune`, which every version since the lock
	// reads; a crashed hold then expires like any lock.
	return withLock(ctx, repository, 'prune', 'hold', async (lease) => {
		try {
			await fetchManifest(ctx, { call: 'hold', id, repository } as At);
		} catch (error) {
			if (error instanceof BackupError && error.code === 'NOT_FOUND')
				return false;
			throw error;
		}
		const file = `${ctx.tmpDir}/nxgt-backup-hold-${crypto.randomUUID()}.json`;
		try {
			await Bun.write(
				file,
				`${JSON.stringify({ format: HOLD_FORMAT, id, heldAt: new Date().toISOString() })}\n`,
			);
			if (!lease.held()) throw leaseLost(ctx, 'hold', id, repository.name);
			await repository.put(holdKey(ctx, id), file);
		} finally {
			await Bun.file(file)
				.delete()
				.catch(() => undefined);
		}
		return true;
	});
}

/**
 * Puts a legal hold on one backup — in every repository that holds it, or
 * in `from` alone: `prune` keeps it there, whatever the policy, until
 * `unhold`. `NOT_FOUND` when no repository asked holds the backup. Takes
 * each repository's lock in turn, so a prune that already read the holds
 * cannot remove it after — and a create running there refuses it `LOCKED`.
 */
export async function holdBackup(
	ctx: BackupContext,
	id: string,
	options: HoldOptions = {},
): Promise<HoldResult> {
	const done: string[] = [];
	for (const repository of targets(ctx, id, options.from, 'hold')) {
		if (await holdIn(ctx, repository, id)) done.push(repository.name);
	}
	if (done.length === 0) {
		throw new BackupError(
			`hold on "${ctx.backup}": no repository holds that backup`,
			{
				code: 'NOT_FOUND',
				backup: ctx.backup,
				id,
			},
		);
	}
	return { id, repositories: done };
}

/**
 * Lifts a backup's legal hold — in every repository, or in `from` alone.
 * Lifting one that is not there is not an error.
 */
export async function unholdBackup(
	ctx: BackupContext,
	id: string,
	options: HoldOptions = {},
): Promise<HoldResult> {
	const done: string[] = [];
	for (const repository of targets(ctx, id, options.from, 'unhold')) {
		await withLock(ctx, repository, 'prune', 'unhold', async (lease) => {
			if (!lease.held()) throw leaseLost(ctx, 'unhold', id, repository.name);
			await repository.delete(holdKey(ctx, id));
		});
		done.push(repository.name);
	}
	return { id, repositories: done };
}

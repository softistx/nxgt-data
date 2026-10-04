import type { Lease } from '../lock/lock';
import { leaseLost } from '../lock/run-locks';
import { type BackupContext, keyOf } from './context';

/** One backup being written: the repositories that have not failed yet. */
export interface Run {
	ctx: BackupContext;
	id: string;
	folder: string;
	failed: Map<string, unknown>;
	/** Each repository's lock, held for the whole run. */
	leases: Map<string, Lease>;
}

/**
 * Puts one staged file into every repository still in the run — checking,
 * before each put, that the lock is still held there: a writer whose lease
 * ran out could be racing a prune that took the lock since. A put already
 * under way when it runs out is not cut short — nothing can be, without a
 * conditional write — so a prune leaves young backups alone.
 */
export async function putAll(
	run: Run,
	key: string,
	file: string,
): Promise<void> {
	await Promise.all(
		run.ctx.repositories
			.filter((repository) => !run.failed.has(repository.name))
			.map(async (repository) => {
				if (!run.leases.get(repository.name)?.held()) {
					run.failed.set(
						repository.name,
						leaseLost(run.ctx, 'create', run.id, repository.name),
					);
					return;
				}
				try {
					await repository.put(keyOf(run.ctx, run.id, key), file);
				} catch (error) {
					run.failed.set(repository.name, error);
				}
			}),
	);
}

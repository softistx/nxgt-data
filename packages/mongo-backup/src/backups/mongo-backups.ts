import {
	type BackupDefinition,
	type BackupInfo,
	type BoundBackup,
	defineBackup,
	localRepository,
	type Repository,
} from '@nxgt/backup';
import type { BackupKeys } from './key-file';
import {
	asCalled,
	bindingOf,
	type Context,
	drillNewest,
	listOf,
	type RestoreReport,
	type RunReport,
	restoreAt,
	runOnce,
} from './operations';
import {
	checkOptions,
	type MongoBackupsOptions,
	type RestoreAtOptions,
} from './options';
import type { DrillReport } from './plan';

export type { RestoreReport, RunReport } from './operations';

export interface MongoBackups {
	/**
	 * One scheduled run. `now` decides only full or incremental; the backup
	 * and its rotation go by the machine's clock.
	 */
	run(now?: Date): Promise<RunReport>;
	/** A backup, chain included, into `into`: whole, or the part the options name. */
	restore(options: RestoreAtOptions): Promise<RestoreReport>;
	/** The newest backup restored into a database of its own, counted, then dropped. */
	drill(): Promise<DrillReport>;
	/** The backups the repository holds, oldest first. Reads the key file, for the key manifests are signed with. */
	list(): Promise<BackupInfo[]>;
	/** The `@nxgt/backup` binding underneath, and the keys: for what this does not do. */
	binding(): Promise<{ backups: BoundBackup; keys: BackupKeys }>;
}

function repositoriesOf(
	repository: MongoBackupsOptions['repository'],
): readonly [Repository, ...Repository[]] {
	if (typeof repository === 'string')
		return [localRepository({ path: repository })];
	if (Array.isArray(repository))
		return repository as [Repository, ...Repository[]];
	return [repository as Repository];
}

/** The backup's definition; `defineBackup`'s refusal, told as this call's. */
function definitionOf(options: MongoBackupsOptions): BackupDefinition {
	try {
		return defineBackup({ name: options.name ?? options.db.databaseName });
	} catch (cause) {
		// The rule as `defineBackup` states it: that call stays its authority.
		const rule = String((cause as Error).message).replace(
			/^defineBackup: the name must be /,
			'',
		);
		throw new TypeError(
			options.name === undefined
				? `mongoBackups: the database's name cannot name a backup; give name: ${rule}`
				: `mongoBackups: name must be ${rule}`,
			{ cause },
		);
	}
}

/**
 * MongoDB backups with the decisions made: one key file, a full backup a
 * week and incrementals in between, every backup read back with the key,
 * a rotation after each run, and one `restore` for a whole database or a
 * part of it. Built on `mongoSource`, `mongoTarget` and
 * `restoreCollections`, which stay there for what this does not do.
 */
export function mongoBackups(options: MongoBackupsOptions): MongoBackups {
	checkOptions(options);
	const ctx: Context = {
		options,
		definition: definitionOf(options),
		repositories: repositoriesOf(options.repository),
	};
	return {
		binding: () => bindingOf(ctx),
		list: () => listOf(ctx),
		run: (now) => asCalled(runOnce(ctx, now), ctx, 'run'),
		restore: (at) => asCalled(restoreAt(ctx, at), ctx, 'restore'),
		drill: () => asCalled(drillNewest(ctx), ctx, 'drill'),
	};
}

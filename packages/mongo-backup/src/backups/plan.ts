import type { BackupInfo } from '@nxgt/backup';
import type { Db } from 'mongodb';
import { MongoBackupError } from '../errors';

/** What a drill restored: each collection and its documents. */
export interface DrillReport {
	id: string;
	collections: { name: string; documents: number }[];
}

/** A full backup when none is younger than `fullEvery`, an incremental otherwise. */
export function kindFor(
	backups: readonly BackupInfo[],
	now: Date,
	fullEvery: number,
): 'full' | 'incremental' {
	const recent = backups.some(
		(backup) =>
			backup.kind === 'full' &&
			now.getTime() - backup.createdAt.getTime() < fullEvery,
	);
	return recent ? 'incremental' : 'full';
}

/**
 * The backup `at` names: an id as it is, a time as the newest backup made
 * at or before it, nothing as the newest of all.
 */
export function chosenBackup(
	backups: readonly BackupInfo[],
	at: string | Date | undefined,
	where: string,
): string {
	if (typeof at === 'string') return at;
	const before = backups
		.filter((b) => at === undefined || b.createdAt.getTime() <= at.getTime())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.at(-1);
	if (!before) {
		throw new MongoBackupError(
			at === undefined
				? `${where}: the repository holds no backup yet`
				: `${where}: no backup was made at or before that time`,
			'NOT_FOUND',
		);
	}
	return before.id;
}

/** Each collection of `db` — views and `system.*` apart — and its documents. */
export async function countsOf(db: Db): Promise<DrillReport['collections']> {
	const listed = await db.listCollections({}, { nameOnly: true }).toArray();
	const counts: DrillReport['collections'] = [];
	for (const info of listed.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (info.type !== 'collection' || info.name.startsWith('system.')) continue;
		counts.push({
			name: info.name,
			documents: await db.collection(info.name).countDocuments(),
		});
	}
	return counts;
}

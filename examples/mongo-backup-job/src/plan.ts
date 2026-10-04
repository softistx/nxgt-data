import type { BackupInfo, KeepPolicy } from '@nxgt/backup';

const DAY = 24 * 60 * 60 * 1000;

/** A new chain starts once the newest full backup is this old. */
export const FULL_EVERY = 7 * DAY;

/**
 * What `prune` keeps after each run: the last day hour by hour, two weeks
 * day by day, two months week by week, a year month by month. A kept
 * incremental keeps the backups it builds on.
 */
export const KEEP: KeepPolicy = { last: 24, daily: 14, weekly: 8, monthly: 12 };

/**
 * A full backup when there is none younger than `FULL_EVERY` — the first
 * run, or a week on — and an incremental on the newest one otherwise.
 */
export function kindFor(
	backups: readonly BackupInfo[],
	now: Date,
): 'full' | 'incremental' {
	const recent = backups.some(
		(backup) =>
			backup.kind === 'full' &&
			now.getTime() - backup.createdAt.getTime() < FULL_EVERY,
	);
	return recent ? 'incremental' : 'full';
}

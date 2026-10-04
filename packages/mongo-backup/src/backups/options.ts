import { isAbsolute } from 'node:path';
import type { KeepPolicy, Repository } from '@nxgt/backup';
import type { Db, Document } from 'mongodb';
import type { CollectionFilter } from '../source/collections';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A full backup a week, incrementals in between. */
export const DEFAULT_FULL_EVERY = 7 * DAY;

/** A day hour by hour, two weeks day by day, two months week by week, a year month by month. */
export const DEFAULT_KEEP: KeepPolicy = {
	last: 24,
	daily: 14,
	weekly: 8,
	monthly: 12,
};

export interface MongoBackupsOptions {
	/** The database backed up. */
	db: Db;
	/** Where backups go: an absolute folder, or `@nxgt/backup` repositories — `s3Repository` among them. */
	repository: string | Repository | readonly [Repository, ...Repository[]];
	/** The file `nxgt-mongo-backup keygen` wrote: an absolute path. */
	keyFile: string;
	/** The backup's name in the repository. The database's name by default. */
	name?: string | undefined;
	/** The collections backed up. All of them by default. */
	collections?: CollectionFilter | undefined;
	/** How old the newest full backup may grow before `run` makes another. A week by default. */
	fullEvery?: number | undefined;
	/** What `run` keeps after each backup; `false` keeps everything. `DEFAULT_KEEP` by default. */
	keep?: KeepPolicy | false | undefined;
	/** Where objects and changes are staged. The system's temporary folder by default. */
	tmpDir?: string | undefined;
}

/** Which backup to restore, where to, and how much of it. */
export type RestoreAtOptions = RestoreWhole | RestoreDocuments;

interface RestoreCommon {
	/** The database to restore into: another, or the one backed up. */
	into: Db;
	/** A backup's id, or a time: the newest backup made at or before it. The newest by default. */
	at?: string | Date | undefined;
	/** Some collections and views only, by their name at the backup's time. */
	collections?: CollectionFilter | undefined;
	/** Other names to restore them under. */
	as?:
		| Readonly<Record<string, string>>
		| ((name: string) => string)
		| undefined;
}

/** Collections and views whole, each landed whole or not at all. */
interface RestoreWhole extends RestoreCommon {
	documents?: undefined;
	/** Replace collections and views already there, rather than refuse them. */
	replace?: boolean | undefined;
}

/** Some documents only, merged into what is there: `existing` says how. */
interface RestoreDocuments extends RestoreCommon {
	documents: { filter: Document; existing: 'replace' | 'keep' };
	replace?: never;
}

// A copy of @nxgt/backup's checkPolicy rule list (AGENTS.md, duplication):
// tied to KeepPolicy so a rule added there fails the typecheck here.
const RULES = [
	'last',
	'hourly',
	'daily',
	'weekly',
	'monthly',
	'yearly',
	'within',
	'maxTotalSize',
] as const satisfies readonly (keyof KeepPolicy)[];
type Missing = Exclude<keyof KeepPolicy, (typeof RULES)[number]>;
/** Fails to compile when KeepPolicy gains a rule RULES lacks. */
export const RULES_COVER_KEEP: [Missing] extends [never] ? true : never = true;

/** `keep` names a rule: checked when it is configured, not after a backup is stored. */
function checkKeep(keep: unknown): void {
	if (keep === undefined || keep === false) return;
	const policy = keep as Record<string, unknown> | null;
	const named =
		typeof policy === 'object' &&
		policy !== null &&
		RULES.some((rule) => policy[rule] !== undefined) &&
		RULES.every((rule) => {
			const value = policy[rule];
			return (
				value === undefined ||
				(Number.isSafeInteger(value) && (value as number) >= 1)
			);
		});
	if (!named) {
		throw new TypeError(
			'mongoBackups: keep must be false, or name rules each a whole number, 1 or more',
		);
	}
}

/** What `restore` refuses before it reads a backup; `restoreCollections` checks the rest. */
export function checkRestore(at: RestoreAtOptions, where: string): void {
	const into = at?.into as Partial<Db> | undefined;
	if (
		typeof into?.collection !== 'function' ||
		typeof into.databaseName !== 'string'
	) {
		throw new TypeError(`${where}: into must be a MongoDB Db`);
	}
	const when = at?.at;
	if (when instanceof Date && Number.isNaN(when.getTime())) {
		throw new TypeError(`${where}: at must be a backup's id or a valid Date`);
	}
	// Also restoreCollections's, but refused here before a backup is read.
	if (at?.documents !== undefined && at.replace !== undefined) {
		throw new TypeError(
			`${where}: replace is for whole collections; documents says what happens to those there`,
		);
	}
}

export function checkOptions(options: MongoBackupsOptions): void {
	const db = options?.db as Partial<Db> | undefined;
	if (
		typeof db?.collection !== 'function' ||
		typeof db.databaseName !== 'string'
	) {
		throw new TypeError('mongoBackups: db must be a MongoDB Db');
	}
	if (typeof options.keyFile !== 'string' || !isAbsolute(options.keyFile)) {
		throw new TypeError('mongoBackups: keyFile must be an absolute path');
	}
	const { repository } = options;
	const isRepository = (r: unknown) =>
		typeof (r as Partial<Repository> | null)?.name === 'string';
	if (
		typeof repository === 'string'
			? !isAbsolute(repository)
			: Array.isArray(repository)
				? !repository.every(isRepository)
				: !isRepository(repository)
	) {
		throw new TypeError(
			'mongoBackups: repository must be an absolute folder, or repositories',
		);
	}
	checkKeep(options.keep);
	if (Array.isArray(repository)) {
		const names = new Set(repository.map((r: Repository) => r?.name));
		if (repository.length === 0 || names.size !== repository.length) {
			throw new TypeError(
				'mongoBackups: repository must list repositories, each under a name of its own',
			);
		}
	}
	if (options.tmpDir !== undefined && !isAbsolute(options.tmpDir)) {
		throw new TypeError('mongoBackups: tmpDir must be an absolute path');
	}
	const every = options.fullEvery;
	if (every !== undefined && (!Number.isSafeInteger(every) || every < HOUR)) {
		throw new TypeError(
			'mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more',
		);
	}
}

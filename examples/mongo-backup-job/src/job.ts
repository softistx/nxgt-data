import {
	type BoundBackup,
	bindBackup,
	defineBackup,
	localRepository,
} from '@nxgt/backup';
import {
	MongoBackupError,
	mongoSource,
	restoreCollections,
} from '@nxgt/mongo-backup';
import type { Db } from 'mongodb';
import type { JobConfig } from './config';
import { KEEP, kindFor } from './plan';

export const definition = defineBackup({ name: 'shop-db' });

/** The backups, the database they hold, and the key to read them. */
export interface Job {
	backups: BoundBackup<'shop-db'>;
	db: Db;
	identities: readonly string[];
}

/** Binds the backup to its repository and keys; the public signing key is derived. */
export function jobOf(config: JobConfig, db: Db): Job {
	return {
		backups: bindBackup(definition, {
			repositories: [localRepository({ path: config.repositoryPath })],
			recipients: [config.recipient],
			signing: { key: config.signingKey },
		}),
		db,
		identities: [config.identity],
	};
}

/** What a run did, for the logs: ids and sizes, never a key nor a document. */
export interface BackupReport {
	id: string;
	kind: 'full' | 'incremental';
	entries: number;
	storedSize: number;
	/** How many backups a restore of this one reads: itself and those it builds on. */
	chain: number;
	/** The backups `prune` removed. */
	removed: string[];
}

/**
 * One scheduled run: a full backup or an incremental, as `kindFor` says —
 * a full one when the oplog no longer reaches the last backup — checked
 * end to end with the key — a backup never read back is not one
 * yet — then the rotation.
 */
export async function backupJob(
	job: Job,
	now = new Date(),
): Promise<BackupReport> {
	const { backups, identities } = job;
	const source = mongoSource({ db: job.db });
	let kind = kindFor((await backups.list()).backups, now);
	const created =
		kind === 'full'
			? await backups.create(source)
			: await backups.create(source, { kind, identities }).catch((error) => {
					// The oplog no longer reaches where the chain stopped: every
					// incremental would fail alike until a full backup starts anew.
					if (!(error instanceof MongoBackupError)) throw error;
					if (error.code !== 'HISTORY_LOST') throw error;
					kind = 'full';
					return backups.create(source);
				});
	const verified = await backups.verify(created.id, { identities });
	const pruned = await backups.prune({ keep: KEEP });
	return {
		id: created.id,
		kind,
		entries: created.entries,
		storedSize: created.storedSize,
		chain: verified.chain.length,
		removed: pruned.removed.map((decision) => decision.id),
	};
}

/** What a drill restored: each collection and its documents. */
export interface DrillReport {
	id: string;
	collections: { name: string; documents: number }[];
}

/**
 * A restore drill: the newest backup, chain included, restored into a
 * database of its own, counted, then dropped. A backup that has never been
 * restored is a hope; run this on a schedule too.
 */
export async function restoreDrill(job: Job): Promise<DrillReport> {
	const { backups } = await job.backups.list();
	const newest = backups.at(-1);
	if (!newest) throw new Error('mongo-backup-job: no backup to drill');
	const drill = job.db.client.db(`drill-${crypto.randomUUID()}`);
	try {
		const restored = await restoreCollections(job.backups, newest.id, {
			identities: job.identities,
			db: drill,
		});
		const collections = [];
		for (const { as } of restored.collections) {
			const info = await drill.listCollections({ name: as }).next();
			if (info?.type === 'view') continue;
			collections.push({
				name: as,
				documents: await drill.collection(as).countDocuments(),
			});
		}
		return { id: newest.id, collections };
	} finally {
		await drill.dropDatabase();
	}
}

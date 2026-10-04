import { mongoBackups } from '@nxgt/mongo-backup';
import type { MongoClient } from 'mongodb';

/**
 * The shop database's backups, configured by the environment:
 * `MONGO_DB`, `BACKUP_PATH` (an absolute folder) and `BACKUP_KEY_FILE`
 * (written by `bunx nxgt-mongo-backup keygen`). A full backup a week,
 * incrementals in between, a rotation after each run: the defaults.
 */
export function shopBackups(
	client: MongoClient,
	env: Record<string, string | undefined> = Bun.env,
) {
	const missing = ['MONGO_DB', 'BACKUP_PATH', 'BACKUP_KEY_FILE'].filter(
		(name) => !env[name],
	);
	if (missing.length > 0) {
		throw new Error(`mongo-backup-job: set ${missing.join(', ')}`);
	}
	return mongoBackups({
		db: client.db(env['MONGO_DB'] as string),
		repository: env['BACKUP_PATH'] as string,
		keyFile: env['BACKUP_KEY_FILE'] as string,
	});
}

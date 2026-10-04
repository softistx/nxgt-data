import { readFile } from 'node:fs/promises';

/** What the job needs, read from the environment: secrets from files, never from variables. */
export interface JobConfig {
	/** `MONGO_URL`: a replica set or a sharded cluster. */
	mongoUrl: string;
	/** `MONGO_DB`: the database backed up. */
	database: string;
	/** `BACKUP_PATH`: an absolute folder, the local repository. */
	repositoryPath: string;
	/** `BACKUP_RECIPIENT`: the age public key backups are encrypted to. */
	recipient: string;
	/** Read from `BACKUP_IDENTITY_FILE`: the age secret key, to build on a backup and to check it. */
	identity: string;
	/** Read from `BACKUP_SIGNING_KEY_FILE`: the Ed25519 private key, PEM, manifests are signed with. */
	signingKey: string;
}

const VARIABLES = [
	'MONGO_URL',
	'MONGO_DB',
	'BACKUP_PATH',
	'BACKUP_RECIPIENT',
	'BACKUP_IDENTITY_FILE',
	'BACKUP_SIGNING_KEY_FILE',
] as const;

/**
 * The job's configuration. A variable missing is named in the error; a
 * value never is — the error ends up in logs.
 */
export async function configFromEnv(
	env: Record<string, string | undefined> = Bun.env,
): Promise<JobConfig> {
	const missing = VARIABLES.filter((name) => !env[name]);
	if (missing.length > 0) {
		throw new Error(`mongo-backup-job: set ${missing.join(', ')}`);
	}
	const value = (name: (typeof VARIABLES)[number]) => env[name] as string;
	return {
		mongoUrl: value('MONGO_URL'),
		database: value('MONGO_DB'),
		repositoryPath: value('BACKUP_PATH'),
		recipient: value('BACKUP_RECIPIENT'),
		identity: (await readFile(value('BACKUP_IDENTITY_FILE'), 'utf8')).trim(),
		signingKey: await readFile(value('BACKUP_SIGNING_KEY_FILE'), 'utf8'),
	};
}

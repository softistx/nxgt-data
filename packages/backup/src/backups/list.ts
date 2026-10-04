import { BackupError } from '../errors/backup-error';
import { isBackupId } from '../format/ids';
import { type BackupContext, repositoryOf } from './context';
import { type At, fetchManifest, MANIFEST } from './read';

export interface ListOptions {
	/** The repository to list, by name. The first one by default. */
	from?: string | undefined;
}

/** One backup a repository holds, as its manifest describes it. */
export interface BackupInfo {
	id: string;
	createdAt: Date;
	kind: 'full';
	/** How many entries it holds. */
	entries: number;
	/** The bytes the repository holds for it, manifest apart. */
	storedSize: number;
}

/** What `list` found: the backups, oldest first, and the ids it could not read. */
export interface Listing {
	repository: string;
	backups: BackupInfo[];
	/**
	 * Ids whose manifest is there but does not read as one this package
	 * wrote — or, with trusted keys, is not signed by one of them. `verify`
	 * on one of them says why.
	 */
	unreadable: string[];
}

/**
 * The backups one repository holds, read from their manifests alone: no
 * key is needed, and a backup whose manifest was never written — one still
 * being made, or one that failed — is not listed.
 */
export async function listBackups(
	ctx: BackupContext,
	options: ListOptions = {},
): Promise<Listing> {
	const repository = repositoryOf(ctx, options.from, 'list');
	const ids: string[] = [];
	const prefix = `${ctx.backup}/`;
	for await (const key of repository.list(prefix)) {
		const [id, file, ...rest] = key.slice(prefix.length).split('/');
		if (file === MANIFEST && rest.length === 0 && isBackupId(id)) ids.push(id);
	}
	ids.sort();
	const backups: BackupInfo[] = [];
	const unreadable: string[] = [];
	for (const id of ids) {
		const at: At = { call: 'list', id, repository };
		try {
			const manifest = await fetchManifest(ctx, at);
			backups.push({
				id,
				createdAt: new Date(manifest.createdAt),
				kind: manifest.kind,
				entries: manifest.objects.length,
				storedSize: [manifest.catalog, ...manifest.objects].reduce(
					(sum, o) => sum + o.size,
					0,
				),
			});
		} catch (error) {
			if (
				!(error instanceof BackupError) ||
				(error.code !== 'INTEGRITY' && error.code !== 'SIGNATURE')
			)
				throw error;
			unreadable.push(id);
		}
	}
	return { repository: repository.name, backups, unreadable };
}

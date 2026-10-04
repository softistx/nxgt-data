import { BackupError } from '../errors/backup-error';
import { isBackupId } from '../format/ids';
import type { BackupKind } from '../format/manifest';
import type { Repository } from '../repository/types';
import { heldIds } from '../rotation/holds';
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
	kind: BackupKind;
	/** The backup it builds on: `null` for a full one. */
	parent: string | null;
	/** How many entries it stores itself: an incremental one points to the rest. */
	entries: number;
	/** The bytes the repository holds for it, manifest apart. */
	storedSize: number;
	/** Whether it is under a legal hold: `prune` never removes it. */
	held: boolean;
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

/** The ids of every manifest in `repository`, oldest first. */
export async function manifestIds(
	ctx: BackupContext,
	repository: Repository,
): Promise<string[]> {
	const ids: string[] = [];
	const prefix = `${ctx.backup}/`;
	for await (const key of repository.list(prefix)) {
		const [id, file, ...rest] = key.slice(prefix.length).split('/');
		if (file === MANIFEST && rest.length === 0 && isBackupId(id)) ids.push(id);
	}
	return ids.sort();
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
	const ids = await manifestIds(ctx, repository);
	const held = await heldIds(ctx, repository);
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
				parent: manifest.parent,
				entries: manifest.objects.length,
				storedSize: [manifest.catalog, ...manifest.objects].reduce(
					(sum, o) => sum + o.size,
					0,
				),
				held: held.has(id),
			});
		} catch (error) {
			if (!(error instanceof BackupError)) throw error;
			// Gone between the listing and the read — pruned meanwhile: a
			// backup that no longer exists is not listed, nor an error.
			if (error.code === 'NOT_FOUND') continue;
			if (error.code !== 'INTEGRITY' && error.code !== 'SIGNATURE') throw error;
			unreadable.push(id);
		}
	}
	return { repository: repository.name, backups, unreadable };
}

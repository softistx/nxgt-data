import { access, copyFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { makeFolders, syncPath, walkFiles } from '../files/files';
import { isKeyPath } from './keys';
import type { Repository } from './types';

export interface LocalRepositoryOptions {
	/** The folder backups are kept in. It is created on the first write. */
	path: string;
	/** How it is named in outcomes and errors. `local` by default. */
	name?: string | undefined;
}

/** Marks a file being written: never listed, never read. */
const PARTIAL = '.partial-';

/** A key's segments, refusing any key that would leave `root`. */
function segmentsOf(key: string): string[] {
	if (!isKeyPath(key) || key.includes(PARTIAL)) {
		throw new TypeError('local repository: a key is not a relative path');
	}
	return key.split('/');
}

function fileOf(root: string, key: string): string {
	return join(root, ...segmentsOf(key));
}

/**
 * A repository in a local folder — a disk, a mounted volume, a network
 * share. A write goes to `<key>.partial-<random>` first, is synced to disk,
 * renamed into place and its folder synced — and each folder it had to
 * create synced in its parent — so a crash leaves either the old bytes or
 * the new ones and never part of them. Symbolic links inside it are never
 * listed nor followed by `list`.
 */
export function localRepository(options: LocalRepositoryOptions): Repository {
	if (typeof options.path !== 'string' || !isAbsolute(options.path)) {
		throw new TypeError('localRepository: path must be an absolute path');
	}
	const root = resolve(options.path);
	return {
		name: options.name ?? 'local',
		async put(key, file) {
			const target = fileOf(root, key);
			// A delete empties and removes folders; one racing this put can take
			// a folder from under it between its creation and the copy. Made
			// again, a few times, rather than failing a lock or a backup on it.
			for (let attempt = 1; ; attempt++) {
				try {
					await makeFolders(dirname(target));
					await land(file, target);
					break;
				} catch (error) {
					if (!(await raced(error, dirname(target))) || attempt === 5) {
						throw error;
					}
				}
			}
			await syncPath(dirname(target));
		},
		async get(key) {
			const file = Bun.file(fileOf(root, key));
			return (await file.exists()) ? file.stream() : undefined;
		},
		list(prefix) {
			const under = prefix.endsWith('/') ? segmentsOf(prefix.slice(0, -1)) : [];
			return (async function* () {
				const partial = (name: string) => name.includes(PARTIAL);
				for await (const segments of walkFiles(root, under, partial)) {
					const key = segments.join('/');
					if (key.startsWith(prefix)) yield key;
				}
			})();
		},
		async delete(key) {
			const file = fileOf(root, key);
			await rm(file, { force: true });
			await removeEmptyFolders(root, dirname(file));
		},
	};
}

/**
 * Whether a failed put lost a race with a delete: its folder is gone — on
 * macOS a copy into a folder removed meanwhile fails `EINVAL`, not
 * `ENOENT` — or something on the way to it was (`ENOENT`), though another
 * put may have made the folder again since: measured on CI's Linux, the
 * sync of a parent folder failed `ENOENT` while the folder stood again.
 */
export async function raced(error: unknown, folder: string): Promise<boolean> {
	if ((error as { code?: unknown } | null)?.code === 'ENOENT') return true;
	return !(await exists(folder));
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** Copies `file` to `target` through a partial file, synced, then renamed. */
async function land(file: string, target: string): Promise<void> {
	const random = crypto.getRandomValues(new Uint8Array(6));
	const partial = `${target}${PARTIAL}${Buffer.from(random).toString('hex')}`;
	try {
		await copyFile(file, partial);
		await syncPath(partial);
		await rename(partial, target);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
}

/**
 * Removes `folder` and its parents up to `root`, while they are empty: a
 * pruned backup leaves no folder behind. The first that is not empty — or
 * already gone — stops it.
 */
async function removeEmptyFolders(root: string, folder: string): Promise<void> {
	let current = folder;
	while (current !== root && current.startsWith(`${root}/`)) {
		try {
			await rmdir(current);
		} catch {
			return;
		}
		current = dirname(current);
	}
}

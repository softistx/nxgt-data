import { copyFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { makeFolders, syncPath, walkFiles } from '../files/files';
import type { Repository } from './types';

export interface LocalRepositoryOptions {
	/** The folder backups are kept in. It is created on the first write. */
	path: string;
	/** How it is named in outcomes and errors. `local` by default. */
	name?: string | undefined;
}

/** Marks a file being written: never listed, never read. */
const PARTIAL = '.partial-';

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** A key's segments, refusing any key that would leave `root`. */
function segmentsOf(key: string): string[] {
	const segments = key.split('/');
	if (
		!segments.every(
			(segment) =>
				SEGMENT.test(segment) &&
				segment !== '.' &&
				segment !== '..' &&
				!segment.includes(PARTIAL),
		)
	) {
		throw new TypeError('local repository: a key is not a relative path');
	}
	return segments;
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
	const root = options.path;
	return {
		name: options.name ?? 'local',
		async put(key, file) {
			const target = fileOf(root, key);
			await makeFolders(dirname(target));
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
			await rm(fileOf(root, key), { force: true });
		},
	};
}

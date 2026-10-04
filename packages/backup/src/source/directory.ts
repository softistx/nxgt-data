import { link, lstat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { codeOf, makeFoldersInside, syncPath, walkFiles } from '../files/files';
import type { BackupSource, RestoreTarget, SourceEntry } from './types';

export interface DirectoryOptions {
	/** The folder, as an absolute path. */
	path: string;
}

/**
 * Every regular file under a folder, named by its path relative to it with
 * `/` between segments, in sorted order. Symbolic links — to a file or to a
 * folder — are skipped, not followed: a link could lead anywhere, including
 * back into the folder.
 * Empty folders are not recorded.
 */
export function directorySource(options: DirectoryOptions): BackupSource {
	const root = absolute(options.path, 'directorySource');
	return {
		kind: 'directory',
		async *entries(): AsyncIterable<SourceEntry> {
			// A folder that is not there is an error, not an empty backup: a
			// mount that did not come up must not pass for a source with nothing.
			await readdir(root);
			const names: string[] = [];
			for await (const segments of walkFiles(root, [], () => false)) {
				names.push(segments.join('/'));
			}
			names.sort();
			for (const name of names) {
				yield {
					name,
					open: () => Bun.file(join(root, ...name.split('/'))).stream(),
				};
			}
		},
	};
}

const NOT_INSIDE =
	'directoryTarget: an entry name is not a relative path inside the folder';
const ALREADY_THERE =
	'directoryTarget: a file is already there; pass overwrite: true to replace it';

const NO_LINKS = new Set<unknown>(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

export interface DirectoryTargetOptions extends DirectoryOptions {
	/** Replace a file that is already there. `false` by default: refuse it. */
	overwrite?: boolean | undefined;
}

/**
 * Writes each entry to a file under a folder. A name comes from a backup,
 * which comes from a repository, so it is not trusted: one that is absolute
 * or holds an empty, `.` or `..` segment is refused before anything is
 * written, and so is one whose folder is already there as a symbolic link,
 * which would carry the write outside the folder. Each file is written
 * beside its place, synced, and moved into it once the stream has ended
 * cleanly, so a damaged entry never lands; without `overwrite` the move
 * itself refuses a file that appeared meanwhile.
 */
export function directoryTarget(
	options: DirectoryTargetOptions,
): RestoreTarget {
	const root = absolute(options.path, 'directoryTarget');
	return {
		async write(name, stream) {
			const segments = name.split('/');
			if (
				name.includes('\\') ||
				segments.some((s) => s === '' || s === '.' || s === '..')
			) {
				await stream.cancel();
				throw new TypeError(NOT_INSIDE);
			}
			const file = join(root, ...segments);
			if (!(await makeFoldersInside(root, segments.slice(0, -1)))) {
				await stream.cancel();
				throw new TypeError(NOT_INSIDE);
			}
			if (!options.overwrite && (await present(file))) {
				await stream.cancel();
				throw new TypeError(ALREADY_THERE);
			}
			await land(file, stream, options.overwrite === true);
		},
	};
}

async function land(
	file: string,
	stream: ReadableStream<Uint8Array>,
	overwrite: boolean,
): Promise<void> {
	const partial = `${file}.partial-${crypto.randomUUID()}`;
	try {
		await Bun.write(partial, new Response(stream));
		await syncPath(partial);
		if (overwrite) {
			await rename(partial, file);
		} else {
			await link(partial, file).catch(async (error: unknown) => {
				if (codeOf(error) === 'EEXIST') throw new TypeError(ALREADY_THERE);
				// A file system without hard links (FAT, some network mounts):
				// check, then move — the window the link closed stays open there.
				if (!NO_LINKS.has(codeOf(error))) throw error;
				if (await present(file)) throw new TypeError(ALREADY_THERE);
				await rename(partial, file);
			});
		}
	} finally {
		await rm(partial, { force: true });
	}
	await syncPath(dirname(file));
}

async function present(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		(error: unknown) => {
			if (codeOf(error) === 'ENOENT') return false;
			throw error;
		},
	);
}

function absolute(path: unknown, where: string): string {
	if (typeof path !== 'string' || !isAbsolute(path)) {
		throw new TypeError(`${where}: path must be an absolute path`);
	}
	return path;
}

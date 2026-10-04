import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** Flushes a file, or a folder's entries, to the disk. */
export async function syncPath(path: string): Promise<void> {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Creates `folder` and its missing parents, then syncs each folder that now
 * names a new one, so a crash cannot take back a folder a later write was
 * reported durable in. `folder` itself is the caller's to sync once it has
 * written in it.
 */
export async function makeFolders(folder: string): Promise<void> {
	const first = await mkdir(folder, { recursive: true });
	if (first === undefined) return;
	await syncPath(dirname(first));
	let current = first;
	for (const segment of relative(first, folder).split(sep).filter(Boolean)) {
		await syncPath(current);
		current = join(current, segment);
	}
}

/**
 * Every regular file under `root`, as its segments relative to it, walking
 * one folder at a time: a symbolic link, to a file or to a folder, is
 * skipped and never followed. A missing folder holds nothing: it may be
 * gone between being listed and being read.
 */
export async function* walkFiles(
	root: string,
	under: readonly string[],
	skip: (name: string) => boolean,
): AsyncIterable<string[]> {
	let entries: Awaited<ReturnType<typeof readFolder>>;
	try {
		entries = await readFolder(join(root, ...under));
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		if (skip(entry.name)) continue;
		if (entry.isDirectory()) {
			yield* walkFiles(root, [...under, entry.name], skip);
		} else if (entry.isFile()) {
			yield [...under, entry.name];
		}
	}
}

function readFolder(folder: string) {
	return readdir(folder, { withFileTypes: true });
}

/**
 * Creates the folders `segments` names under `root`, refusing any segment
 * that is already there as something other than a real folder — a symbolic
 * link above all, which would carry the next write outside `root`.
 */
export async function makeFoldersInside(
	root: string,
	segments: readonly string[],
): Promise<boolean> {
	await makeFolders(root);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		const found = await lstat(current).catch((error: unknown) => {
			if (codeOf(error) === 'ENOENT') return undefined;
			throw error;
		});
		if (found === undefined) await makeFolders(current);
		else if (!found.isDirectory()) return false;
	}
	return true;
}

export function codeOf(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error
		? error.code
		: undefined;
}

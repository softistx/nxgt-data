import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Base, Known } from '../chain/base';
import { sealToFile } from '../crypto/seal';
import {
	type CatalogEntry,
	FINGERPRINT_MAX,
	isEntryName,
	isOptionalText,
	POSITION_MAX,
} from '../format/catalog';
import type { StoredObject } from '../format/manifest';
import type { BackupSource, SourceEntry } from '../source/types';
import { putAll, type Run } from './run';

/** Seals one stream into the staging folder, stores it, and removes it. */
export async function store(
	run: Run,
	key: string,
	stream: ReadableStream<Uint8Array>,
): Promise<StoredObject> {
	const file = join(run.folder, key);
	try {
		const sealed = await sealToFile(stream, run.ctx.recipients, file);
		await putAll(run, key, file);
		return { key, ...sealed.stored };
	} finally {
		await rm(file, { force: true });
	}
}

/** Whether every repository has failed: nothing more is worth reading. */
export function nowhereLeft(run: Run): boolean {
	return run.failed.size === run.ctx.repositories.length;
}

/** What `storeEntries` gathered: the catalog's entries and the objects. */
export interface Stored {
	entries: CatalogEntry[];
	objects: StoredObject[];
	/** How many entries point to an object of the backup built on. */
	reused: number;
	position: string | undefined;
}

function checkEntry(run: Run, entry: SourceEntry, names: Set<string>): void {
	if (!isEntryName(entry.name) || names.has(entry.name)) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the source gave an entry name that is ` +
				'empty, over 4096 characters, holds a NUL, or was given twice',
		);
	}
	if (!isOptionalText(entry.fingerprint, FINGERPRINT_MAX)) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the source gave a fingerprint that is ` +
				'not a string of at most 1024 bytes',
		);
	}
	names.add(entry.name);
}

/**
 * Seals one entry and stores it — unless the backup built on recorded the
 * same bytes under its name: the sealed file is then dropped, and the
 * entry points to the object already stored.
 */
async function storeOne(
	run: Run,
	entry: SourceEntry,
	key: string,
	base: Base | undefined,
): Promise<{ entry: CatalogEntry; object?: StoredObject }> {
	const file = join(run.folder, key);
	try {
		const sealed = await sealToFile(
			await entry.open(),
			run.ctx.recipients,
			file,
		);
		const known = base?.known.get(entry.name);
		const fingerprint =
			entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint };
		// The same digest is the same bytes: the size is in what it hashed.
		if (base && known?.sha256 === sealed.plain.sha256) {
			return { entry: pointer(entry, known) };
		}
		await putAll(run, key, file);
		return {
			entry: { name: entry.name, object: key, ...sealed.plain, ...fingerprint },
			object: { key, ...sealed.stored },
		};
	} finally {
		await rm(file, { force: true });
	}
}

/** An entry pointing to the object the backup built on already has. */
function pointer(entry: SourceEntry, known: Known): CatalogEntry {
	return {
		name: entry.name,
		object: known.object,
		in: known.in,
		size: known.size,
		sha256: known.sha256,
		...(entry.fingerprint === undefined
			? {}
			: { fingerprint: entry.fingerprint }),
	};
}

/**
 * Reads the source's entries in turn and stores them. Given a `base`, an
 * entry whose fingerprint is the recorded one is not opened, and one whose
 * bytes are the recorded ones is not stored: both point to the object the
 * base already has. Then asks the source where it stands.
 */
export async function storeEntries(
	run: Run,
	source: BackupSource,
	base: Base | undefined,
): Promise<Stored> {
	const entries: CatalogEntry[] = [];
	const objects: StoredObject[] = [];
	const names = new Set<string>();
	let reused = 0;
	for await (const entry of source.entries(base?.since)) {
		checkEntry(run, entry, names);
		const known = base?.known.get(entry.name);
		if (
			base &&
			known &&
			entry.fingerprint !== undefined &&
			entry.fingerprint === known.fingerprint
		) {
			entries.push(pointer(entry, known));
			reused++;
			continue;
		}
		const one = await storeOne(run, entry, `${objects.length}.age`, base);
		entries.push(one.entry);
		if (one.object) objects.push(one.object);
		else reused++;
		if (nowhereLeft(run)) break;
	}
	const position = await source.position?.();
	if (!isOptionalText(position, POSITION_MAX)) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the source gave a position that is ` +
				'not a string of at most 64 KiB',
		);
	}
	return { entries, objects, reused, position };
}

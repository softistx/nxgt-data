import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chainOf, openEntry } from '../chain/view';
import { decrypterFor } from '../crypto/keys';
import type { CatalogEntry } from '../format/catalog';
import type { RestoreTarget } from '../source/types';
import { type BackupContext, repositoryOf } from './context';
import { type At, failure, fetchCatalog, fetchManifest } from './read';

export interface RestoreOptions {
	/** The age secret keys to open the backup with. */
	identities: readonly string[];
	/** The repository to read from, by name. The first one by default. */
	from?: string | undefined;
	/**
	 * Which entries to take back: their names, or a test on each name. All
	 * of them by default. A name given that the backup does not hold is
	 * `NOT_FOUND`, before anything is written.
	 */
	only?: readonly string[] | ((name: string) => boolean) | undefined;
}

/** What `restore` wrote. */
export interface Restored {
	id: string;
	repository: string;
	/** The names of the entries written, in the backup's order. */
	entries: string[];
	/** Their bytes, as the source gave them. */
	size: number;
}

function selected(
	ctx: BackupContext,
	at: At,
	entries: readonly CatalogEntry[],
	only: RestoreOptions['only'],
): CatalogEntry[] {
	if (only === undefined) return [...entries];
	if (typeof only === 'function')
		return entries.filter((entry) => only(entry.name));
	const names = new Set(entries.map((entry) => entry.name));
	if (!only.every((name) => names.has(name))) {
		throw failure(
			ctx,
			at,
			'NOT_FOUND',
			'an entry asked for is not in the backup',
		);
	}
	const wanted = new Set(only);
	return entries.filter((entry) => wanted.has(entry.name));
}

/**
 * Writes a backup's entries to `target`, one at a time — those it stored,
 * and those it points to in the backups it builds on. Each object is
 * staged and checked against the manifest before a byte of it is
 * decrypted, and its plain bytes are checked against what the source gave
 * as they go: a damaged entry fails its stream with `INTEGRITY`, and the
 * restore stops there. What was written before it stays written. The checks
 * run at the stream's end, so a target must read it to the end before its
 * `write` resolves; one that does not is refused with a `TypeError`.
 */
export async function restoreBackup(
	ctx: BackupContext,
	id: string,
	target: RestoreTarget,
	options: RestoreOptions,
): Promise<Restored> {
	const at: At = {
		call: 'restore',
		id,
		repository: repositoryOf(ctx, options.from, 'restore'),
	};
	const decrypter = decrypterFor(options.identities, 'restore');
	const manifest = await fetchManifest(ctx, at);
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-restore-'));
	try {
		const file = join(folder, 'object.age');
		const catalog = await fetchCatalog(ctx, at, manifest, decrypter, file);
		const entries = selected(ctx, at, catalog.entries, options.only);
		const chain = await chainOf(ctx, at, manifest);
		for (const entry of entries) {
			const seen = { ended: false };
			const { stream: checked } = await openEntry(
				ctx,
				at,
				chain,
				entry,
				decrypter,
				file,
				seen,
			);
			await target.write(entry.name, checked);
			if (!seen.ended) {
				await checked.cancel().catch(() => undefined);
				throw new TypeError(
					`restore on "${ctx.backup}": the target resolved write before reading ` +
						'its stream to the end, so nothing it was given was checked',
				);
			}
		}
		return {
			id,
			repository: at.repository.name,
			entries: entries.map((entry) => entry.name),
			size: entries.reduce((sum, entry) => sum + entry.size, 0),
		};
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

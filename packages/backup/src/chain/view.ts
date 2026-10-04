import type { Decrypter } from 'age-encryption';
import type { BackupContext } from '../backups/context';
import {
	type At,
	decrypted,
	failure,
	fetchManifest,
	guarded,
	stage,
} from '../backups/read';
import { openFile } from '../crypto/seal';
import { BackupError } from '../errors/backup-error';
import type { CatalogEntry } from '../format/catalog';
import type { Manifest, StoredObject } from '../format/manifest';

/**
 * A backup's manifest and the manifest of every backup it builds on, by
 * id, newest first — each fetched and checked as `fetchManifest` does.
 * Each parent is older than its child, so the walk ends. One that is gone
 * is `INTEGRITY`: the backup cannot be restored whole without it.
 */
export async function chainOf(
	ctx: BackupContext,
	at: At,
	manifest: Manifest,
): Promise<Map<string, Manifest>> {
	const chain = new Map<string, Manifest>([[manifest.id, manifest]]);
	let child = manifest;
	while (child.parent !== null) {
		let parent: Manifest;
		try {
			parent = await fetchManifest(ctx, { ...at, id: child.parent });
		} catch (error) {
			if (error instanceof BackupError && error.code === 'NOT_FOUND') {
				throw failure(ctx, at, 'INTEGRITY', 'a backup it builds on is missing');
			}
			throw error;
		}
		chain.set(parent.id, parent);
		child = parent;
	}
	return chain;
}

/**
 * Where one entry's object is: in the backup itself, or in the backup of
 * its chain that stored it. A catalog naming a backup outside the chain,
 * or an object that backup does not have, is `INTEGRITY`.
 */
export function locate(
	ctx: BackupContext,
	at: At,
	chain: ReadonlyMap<string, Manifest>,
	entry: CatalogEntry,
): { at: At; object: StoredObject } {
	const holder = entry.in ?? at.id;
	const manifest = chain.get(holder);
	if (!manifest) {
		throw failure(
			ctx,
			at,
			'INTEGRITY',
			'the catalog names a backup outside its chain',
		);
	}
	const object = manifest.objects[Number.parseInt(entry.object, 10)];
	if (object?.key !== entry.object) {
		throw failure(
			ctx,
			at,
			'INTEGRITY',
			'the catalog names an object the manifest lacks',
		);
	}
	return { at: { ...at, id: holder }, object };
}

/**
 * One entry's plain bytes, wherever its object is: staged and checked
 * against the manifest of the backup holding it, then decrypted and checked
 * against the catalog as they go. An error names the backup holding the
 * object. `seen.ended` records a clean end, where the checks run.
 */
export async function openEntry(
	ctx: BackupContext,
	at: At,
	chain: ReadonlyMap<string, Manifest>,
	entry: CatalogEntry,
	decrypter: Decrypter,
	file: string,
	seen: { ended: boolean } = { ended: false },
): Promise<{ stream: ReadableStream<Uint8Array>; object: StoredObject }> {
	const holder = locate(ctx, at, chain, entry);
	await stage(ctx, holder.at, holder.object, file);
	const plain = await decrypted(ctx, holder.at, () =>
		openFile(file, decrypter, entry, () =>
			failure(
				ctx,
				holder.at,
				'INTEGRITY',
				'an entry differs from what its source gave',
			),
		),
	);
	return {
		stream: guarded(ctx, holder.at, plain, seen),
		object: holder.object,
	};
}

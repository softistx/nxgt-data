import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { decrypterFor } from '../crypto/keys';
import { openFile } from '../crypto/seal';
import { type BackupContext, repositoryOf } from './context';
import {
	type At,
	decrypted,
	failure,
	fetchCatalog,
	fetchManifest,
	guarded,
	stage,
} from './read';

export interface VerifyOptions {
	/** The repository to check, by name. The first one by default. */
	from?: string | undefined;
	/**
	 * Age secret keys. Without them, every object's size and SHA-256 are
	 * checked against the manifest, which needs no key and proves the
	 * repository holds what was written. With them, every entry is also
	 * decrypted, decompressed and checked against what the source gave.
	 */
	identities?: readonly string[] | undefined;
}

/** What `verify` checked. */
export interface Verified {
	id: string;
	repository: string;
	/** Objects checked, the catalog included. */
	objects: number;
	/** Their encrypted bytes. */
	storedSize: number;
	/** Whether the entries were decrypted and checked too. */
	decrypted: boolean;
}

/**
 * Reads a whole backup back from one repository and checks it, rejecting
 * with `INTEGRITY` at the first object that differs. Nothing is written
 * anywhere but the staging folder.
 */
export async function verifyBackup(
	ctx: BackupContext,
	id: string,
	options: VerifyOptions = {},
): Promise<Verified> {
	const at: At = {
		call: 'verify',
		id,
		repository: repositoryOf(ctx, options.from, 'verify'),
	};
	const decrypter =
		options.identities === undefined
			? undefined
			: decrypterFor(options.identities, 'verify');
	const manifest = await fetchManifest(ctx, at);
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-verify-'));
	try {
		const file = join(folder, 'object.age');
		if (!decrypter) {
			for (const object of [manifest.catalog, ...manifest.objects]) {
				await stage(ctx, at, object, file);
			}
		} else {
			const catalog = await fetchCatalog(ctx, at, manifest, decrypter, file);
			for (const [index, object] of manifest.objects.entries()) {
				const entry = catalog.entries[index];
				if (!entry)
					throw failure(ctx, at, 'INTEGRITY', 'the catalog misses an entry');
				await stage(ctx, at, object, file);
				const stream = await decrypted(ctx, at, () =>
					openFile(file, decrypter, entry, () =>
						failure(
							ctx,
							at,
							'INTEGRITY',
							'an entry differs from what its source gave',
						),
					),
				);
				for await (const _ of guarded(ctx, at, stream)) {
					// Read to the end: the checks run as the bytes go through.
				}
			}
		}
		return {
			id,
			repository: at.repository.name,
			objects: manifest.objects.length + 1,
			storedSize: [manifest.catalog, ...manifest.objects].reduce(
				(sum, o) => sum + o.size,
				0,
			),
			decrypted: decrypter !== undefined,
		};
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

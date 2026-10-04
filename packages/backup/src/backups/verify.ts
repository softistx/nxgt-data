import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Decrypter } from 'age-encryption';
import { chainOf, openEntry } from '../chain/view';
import { decrypterFor } from '../crypto/keys';
import type { Manifest, StoredObject } from '../format/manifest';
import { type BackupContext, repositoryOf } from './context';
import { type At, fetchCatalog, fetchManifest, stage } from './read';

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
	/**
	 * The backups it read: this one, then each one it builds on, newest
	 * first. Just this one for a full backup.
	 */
	chain: string[];
	/** Objects checked, the catalog included. */
	objects: number;
	/** Their encrypted bytes. */
	storedSize: number;
	/** Whether the entries were decrypted and checked too. */
	decrypted: boolean;
	/** Whether the manifest's signature was checked: trusted keys are set. */
	signatureChecked: boolean;
}

/** Every object of every backup of the chain, against its manifest. */
async function stageAll(
	ctx: BackupContext,
	at: At,
	chain: ReadonlyMap<string, Manifest>,
	file: string,
): Promise<StoredObject[]> {
	const checked: StoredObject[] = [];
	for (const manifest of chain.values()) {
		for (const object of [manifest.catalog, ...manifest.objects]) {
			await stage(ctx, { ...at, id: manifest.id }, object, file);
			checked.push(object);
		}
	}
	return checked;
}

/** The catalog, then every entry it lists, wherever stored, decrypted. */
async function openAll(
	ctx: BackupContext,
	at: At,
	chain: ReadonlyMap<string, Manifest>,
	decrypter: Decrypter,
	file: string,
): Promise<StoredObject[]> {
	const manifest = chain.get(at.id) as Manifest;
	const catalog = await fetchCatalog(ctx, at, manifest, decrypter, file);
	const checked: StoredObject[] = [manifest.catalog];
	for (const entry of catalog.entries) {
		const { stream, object } = await openEntry(
			ctx,
			at,
			chain,
			entry,
			decrypter,
			file,
		);
		for await (const _ of stream) {
			// Read to the end: the checks run as the bytes go through.
		}
		checked.push(object);
	}
	return checked;
}

/**
 * Reads a whole backup back from one repository and checks it, rejecting
 * with `INTEGRITY` at the first object that differs — with the backups it
 * builds on: what a restore of it would read. Without a key, every object
 * of every backup of the chain is checked against its manifest; with one,
 * every entry the backup lists, wherever it is stored. Nothing is written
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
	const chain = await chainOf(ctx, at, manifest);
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-verify-'));
	try {
		const file = join(folder, 'object.age');
		const checked = decrypter
			? await openAll(ctx, at, chain, decrypter, file)
			: await stageAll(ctx, at, chain, file);
		return {
			id,
			repository: at.repository.name,
			chain: [...chain.keys()],
			objects: checked.length,
			storedSize: checked.reduce((sum, o) => sum + o.size, 0),
			decrypted: decrypter !== undefined,
			signatureChecked: ctx.trusted.length > 0,
		};
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

import { createPublicKey, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { checkRecipients } from '../crypto/keys';
import { signerOf, trustedOf } from '../crypto/signing';
import {
	type BackupDefinition,
	isBackupName,
} from '../definition/define-backup';
import type { Repository } from '../repository/types';

export interface BindBackupOptions {
	/**
	 * Where the backup is kept: one repository or several. `create` writes
	 * to every one of them; the others read from the first unless told
	 * which with `from`.
	 */
	repositories: readonly [Repository, ...Repository[]];
	/** The age public keys every backup is encrypted to: `age1…`, `age1pq1…`. */
	recipients: readonly [string, ...string[]];
	/**
	 * Where each object is staged between the source and the repositories,
	 * and between a repository and a restore. One object at a time, removed
	 * as soon as it is done. The system's temporary folder by default.
	 */
	tmpDir?: string | undefined;
	/**
	 * Signs every manifest `create` writes: an Ed25519 private key, PEM
	 * (PKCS#8). Give it only where backups are made.
	 */
	signing?: { key: string } | undefined;
	/**
	 * The Ed25519 public keys (PEM, SPKI) a manifest must be signed by for
	 * `list`, `verify` and `restore` to read it. The public half of
	 * `signing.key` by default; without either, manifests are neither
	 * signed nor checked.
	 */
	trusted?: readonly [string, ...string[]] | undefined;
	/**
	 * The single-writer lock each `create` takes in every repository it
	 * writes to. `lease`, in milliseconds, is how long a lock lasts unless
	 * renewed — every third of it, while the writer runs — and how much
	 * longer a lock past its end is still respected, for clocks that
	 * disagree. 5 minutes by default; 1 second to 1 day.
	 */
	lock?: { lease?: number | undefined } | undefined;
}

/**
 * What every operation reads: resolved once, plain data — the keys as
 * Node's `KeyObject`s, which print and serialise without their material.
 */
export interface BackupContext {
	backup: string;
	repositories: readonly Repository[];
	recipients: readonly string[];
	tmpDir: string;
	/** The key `create` signs with, if any. */
	signer: KeyObject | undefined;
	/** The keys a manifest must be signed by; empty: none is checked. */
	trusted: readonly KeyObject[];
	/** How long a lock lasts unless renewed, in milliseconds. */
	lease: number;
}

export function createContext(
	definition: BackupDefinition,
	options: BindBackupOptions,
): BackupContext {
	if (!isBackupName(definition?.name)) {
		throw new TypeError(
			'bindBackup: the definition did not come from defineBackup',
		);
	}
	const repositories = options.repositories;
	if (!Array.isArray(repositories) || repositories.length === 0) {
		throw new TypeError(
			'bindBackup: repositories must list at least one repository',
		);
	}
	const names = new Set(repositories.map((repository) => repository.name));
	if (names.size !== repositories.length) {
		throw new TypeError('bindBackup: two repositories have the same name');
	}
	const tmpDir = options.tmpDir ?? tmpdir();
	if (!isAbsolute(tmpDir)) {
		throw new TypeError('bindBackup: tmpDir must be an absolute path');
	}
	return {
		backup: definition.name,
		repositories: [...repositories],
		recipients: checkRecipients(options.recipients, 'bindBackup'),
		tmpDir,
		...signingOf(options),
		lease: leaseOf(options),
	};
}

const DEFAULT_LEASE = 5 * 60 * 1000;

function leaseOf(options: BindBackupOptions): number {
	const lease = options.lock?.lease ?? DEFAULT_LEASE;
	if (!Number.isInteger(lease) || lease < 1000 || lease > 86_400_000) {
		throw new TypeError(
			'bindBackup: lock.lease must be a whole number of milliseconds, ' +
				'from 1 second to 1 day',
		);
	}
	return lease;
}

function signingOf(
	options: BindBackupOptions,
): Pick<BackupContext, 'signer' | 'trusted'> {
	const signer =
		options.signing === undefined
			? undefined
			: signerOf(options.signing?.key, 'bindBackup');
	const own = signer && createPublicKey(signer);
	if (options.trusted === undefined) {
		return { signer, trusted: own ? [own] : [] };
	}
	const trusted = trustedOf(options.trusted, 'bindBackup');
	if (own && !trusted.some((key) => key.equals(own))) {
		throw new TypeError(
			'bindBackup: trusted does not hold the public key of signing.key, ' +
				'so this backup could not read what it writes',
		);
	}
	return { signer, trusted };
}

/** The repository a read uses: the one named `from`, or the first. */
export function repositoryOf(
	ctx: BackupContext,
	from: string | undefined,
	where: string,
): Repository {
	if (from === undefined) return ctx.repositories[0] as Repository;
	const found = ctx.repositories.find((repository) => repository.name === from);
	if (!found) {
		throw new TypeError(
			`${where} on "${ctx.backup}": no repository has that name`,
		);
	}
	return found;
}

/** A key of one backup: `<backup>/<id>/<key>`. */
export function keyOf(ctx: BackupContext, id: string, key: string): string {
	return `${ctx.backup}/${id}/${key}`;
}

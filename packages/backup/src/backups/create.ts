import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Base, baseOf } from '../chain/base';
import { decrypterFor } from '../crypto/keys';
import { signBytes } from '../crypto/signing';
import { BackupError, type RepositoryOutcome } from '../errors/backup-error';
import { CATALOG_FORMAT, type Catalog } from '../format/catalog';
import { newBackupId } from '../format/ids';
import {
	type BackupKind,
	MANIFEST_FORMAT,
	MANIFEST_MAX_BYTES,
	type Manifest,
} from '../format/manifest';
import { lockAll, releaseAll } from '../lock/run-locks';
import type { BackupSource } from '../source/types';
import type { BackupContext } from './context';
import { nowhereLeft, type Stored, store, storeEntries } from './entries';
import { MANIFEST, SIGNATURE } from './read';
import { putAll, type Run } from './run';

/**
 * What `create` stores: a full backup by default, or one that builds on
 * an earlier one — which needs a key, to read what that one recorded.
 */
export type CreateOptions =
	| { kind?: 'full' | undefined }
	| {
			/**
			 * `incremental` builds on the newest backup, `differential` on the
			 * newest full one: each stores only the entries that changed since,
			 * and points to the others.
			 */
			kind: 'incremental' | 'differential';
			/** The age secret keys to read the catalog of the backup built on. */
			identities: readonly string[];
			/** Where to look for the backup to build on. The first repository by default. */
			from?: string | undefined;
	  };

/** What `create` stored. */
export interface Created {
	id: string;
	createdAt: Date;
	kind: BackupKind;
	/** The backup it builds on: `null` for a full one. */
	parent: string | null;
	/** How many entries it holds — stored in it, or pointing to its chain. */
	entries: number;
	/** How many of them point to an object of the backup built on. */
	reused: number;
	/** The bytes of its entries, as the source gave them. */
	size: number;
	/** The bytes each repository holds for it, manifest apart. */
	storedSize: number;
	/** Whether its manifest was signed: `signing` was given to `bindBackup`. */
	signed: boolean;
	/** Every repository's outcome: all `stored: true`, or `create` threw. */
	outcomes: RepositoryOutcome[];
}

function bytes(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

function outcomesOf(run: Run): RepositoryOutcome[] {
	return run.ctx.repositories.map((repository) =>
		run.failed.has(repository.name)
			? {
					repository: repository.name,
					stored: false,
					error: run.failed.get(repository.name),
				}
			: { repository: repository.name, stored: true },
	);
}

function settle(run: Run, created: Created): Created {
	const stored = created.outcomes.filter((outcome) => outcome.stored).length;
	if (stored === created.outcomes.length) return created;
	const code = stored === 0 ? 'NOT_STORED' : 'PARTIAL';
	throw new BackupError(
		`create on "${run.ctx.backup}": stored in ${stored} of ${created.outcomes.length} repositories`,
		{ code, backup: run.ctx.backup, id: run.id, outcomes: created.outcomes },
	);
}

/**
 * Puts the manifest, preceded by its signature when there is a signing
 * key: the signature is over the exact bytes written, and goes first so
 * that a manifest — which makes a backup exist — never stands unsigned.
 */
async function putManifest(run: Run, manifest: Manifest): Promise<void> {
	const bytes = new TextEncoder().encode(
		`${JSON.stringify(manifest, null, '\t')}\n`,
	);
	if (bytes.length > MANIFEST_MAX_BYTES) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the manifest would be larger than 64 MiB; ` +
				'split the source into several backups',
		);
	}
	const manifestFile = join(run.folder, MANIFEST);
	await Bun.write(manifestFile, bytes);
	if (run.ctx.signer) {
		const signatureFile = join(run.folder, SIGNATURE);
		await Bun.write(signatureFile, signBytes(run.ctx.signer, bytes));
		await putAll(run, SIGNATURE, signatureFile);
	}
	await putAll(run, MANIFEST, manifestFile);
}

function kindOf(ctx: BackupContext, options: CreateOptions): BackupKind {
	const kind = options.kind ?? 'full';
	if (kind !== 'full' && kind !== 'incremental' && kind !== 'differential') {
		throw new TypeError(
			`create on "${ctx.backup}": kind must be full, incremental or differential`,
		);
	}
	return kind;
}

/** The catalog and the manifest of what was stored, then the outcome. */
async function finish(
	run: Run,
	source: BackupSource,
	createdAt: Date,
	stored: Stored,
	base: Base | undefined,
): Promise<Created> {
	const catalog: Catalog = {
		format: CATALOG_FORMAT,
		source: { kind: source.kind },
		entries: stored.entries,
		...(stored.position === undefined ? {} : { position: stored.position }),
	};
	const catalogObject = await store(
		run,
		'catalog.age',
		bytes(JSON.stringify(catalog)),
	);
	const kind = run.kind;
	const manifest: Manifest = {
		format: MANIFEST_FORMAT,
		backup: run.ctx.backup,
		id: run.id,
		createdAt: createdAt.toISOString(),
		kind,
		parent: base?.manifest.id ?? null,
		recipients: [...run.ctx.recipients],
		compression: 'zstd',
		catalog: catalogObject,
		objects: stored.objects,
	};
	await putManifest(run, manifest);
	return settle(run, {
		id: run.id,
		createdAt,
		kind,
		parent: manifest.parent,
		entries: stored.entries.length,
		reused: stored.reused,
		size: stored.entries.reduce((sum, entry) => sum + entry.size, 0),
		storedSize: [...stored.objects, catalogObject].reduce(
			(sum, o) => sum + o.size,
			0,
		),
		signed: run.ctx.signer !== undefined,
		outcomes: outcomesOf(run),
	});
}

/**
 * Reads every entry of `source`, and stores the backup in every repository:
 * each entry sealed and put in turn, then the catalog, then the manifest —
 * **last**, and only into a repository that took everything before it. A
 * repository that fails is left out from then on; the others go on. An
 * incremental or differential backup first finds the backup it builds on,
 * under the lock, and leaves out a repository that does not hold it.
 */
export async function createBackup(
	ctx: BackupContext,
	source: BackupSource,
	options: CreateOptions = {},
): Promise<Created> {
	if (ctx.trusted.length > 0 && !ctx.signer) {
		throw new TypeError(
			`create on "${ctx.backup}": trusted keys are set but no signing key, ` +
				'so this backup could not read what it writes',
		);
	}
	const kind = kindOf(ctx, options);
	const chained =
		options.kind === 'incremental' || options.kind === 'differential'
			? options
			: undefined;
	const decrypter = chained
		? decrypterFor(chained.identities, `create on "${ctx.backup}"`)
		: undefined;
	const createdAt = new Date();
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-backup-'));
	const run: Run = {
		ctx,
		id: newBackupId(createdAt),
		folder,
		failed: new Map(),
		leases: new Map(),
		kind,
	};
	try {
		run.leases = await lockAll(ctx, 'create', folder, run.failed);
		const base =
			chained && decrypter && !nowhereLeft(run)
				? await baseOf(run, {
						kind: chained.kind,
						from: chained.from,
						decrypter,
						sourceKind: source.kind,
						path: join(folder, 'base.age'),
					})
				: undefined;
		const stored = nowhereLeft(run)
			? { entries: [], objects: [], reused: 0, position: undefined }
			: await storeEntries(run, source, base);
		if (nowhereLeft(run)) {
			return settle(run, {
				id: run.id,
				createdAt,
				kind,
				parent: base?.manifest.id ?? null,
				entries: stored.entries.length,
				reused: 0,
				size: 0,
				storedSize: 0,
				signed: false,
				outcomes: outcomesOf(run),
			});
		}
		return await finish(run, source, createdAt, stored, base);
	} finally {
		await releaseAll(run.leases);
		await rm(folder, { recursive: true, force: true });
	}
}

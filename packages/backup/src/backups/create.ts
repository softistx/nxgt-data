import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sealToFile } from '../crypto/seal';
import { BackupError, type RepositoryOutcome } from '../errors/backup-error';
import {
	CATALOG_FORMAT,
	type Catalog,
	type CatalogEntry,
	isEntryName,
} from '../format/catalog';
import { newBackupId } from '../format/ids';
import {
	MANIFEST_FORMAT,
	type Manifest,
	type StoredObject,
} from '../format/manifest';
import type { BackupSource } from '../source/types';
import { type BackupContext, keyOf } from './context';
import { MANIFEST } from './read';

/** What `create` stored. */
export interface Created {
	id: string;
	createdAt: Date;
	/** How many entries the source gave. */
	entries: number;
	/** The bytes the source gave, before compression. */
	size: number;
	/** The bytes each repository holds for it, manifest apart. */
	storedSize: number;
	/** Every repository's outcome: all `stored: true`, or `create` threw. */
	outcomes: RepositoryOutcome[];
}

/** One backup being written: the repositories that have not failed yet. */
interface Run {
	ctx: BackupContext;
	id: string;
	folder: string;
	failed: Map<string, unknown>;
}

/** Puts one staged file into every repository still in the run. */
async function putAll(run: Run, key: string, file: string): Promise<void> {
	await Promise.all(
		run.ctx.repositories
			.filter((repository) => !run.failed.has(repository.name))
			.map(async (repository) => {
				try {
					await repository.put(keyOf(run.ctx, run.id, key), file);
				} catch (error) {
					run.failed.set(repository.name, error);
				}
			}),
	);
}

/** Seals one stream into the staging folder, stores it, and removes it. */
async function store(
	run: Run,
	key: string,
	stream: ReadableStream<Uint8Array>,
): Promise<{ object: StoredObject; plain: { size: number; sha256: string } }> {
	const file = join(run.folder, key);
	try {
		const sealed = await sealToFile(stream, run.ctx.recipients, file);
		await putAll(run, key, file);
		return { object: { key, ...sealed.stored }, plain: sealed.plain };
	} finally {
		await rm(file, { force: true });
	}
}

async function storeEntries(
	run: Run,
	source: BackupSource,
): Promise<{ entries: CatalogEntry[]; objects: StoredObject[] }> {
	const entries: CatalogEntry[] = [];
	const objects: StoredObject[] = [];
	const names = new Set<string>();
	for await (const entry of source.entries()) {
		if (!isEntryName(entry.name) || names.has(entry.name)) {
			throw new TypeError(
				`create on "${run.ctx.backup}": the source gave an entry name that is ` +
					'empty, over 4096 characters, holds a NUL, or was given twice',
			);
		}
		names.add(entry.name);
		const key = `${objects.length}.age`;
		const { object, plain } = await store(run, key, await entry.open());
		objects.push(object);
		entries.push({ name: entry.name, object: key, ...plain });
		if (nowhereLeft(run)) break;
	}
	return { entries, objects };
}

/** Whether every repository has failed: nothing more is worth reading. */
function nowhereLeft(run: Run): boolean {
	return run.failed.size === run.ctx.repositories.length;
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
 * Reads every entry of `source`, and stores the backup in every repository:
 * each entry sealed and put in turn, then the catalog, then the manifest —
 * **last**, and only into a repository that took everything before it. A
 * repository that fails is left out from then on; the others go on.
 */
export async function createBackup(
	ctx: BackupContext,
	source: BackupSource,
): Promise<Created> {
	const createdAt = new Date();
	const folder = await mkdtemp(join(ctx.tmpDir, 'nxgt-backup-'));
	const run: Run = {
		ctx,
		id: newBackupId(createdAt),
		folder,
		failed: new Map(),
	};
	try {
		const { entries, objects } = await storeEntries(run, source);
		if (nowhereLeft(run)) {
			return settle(run, {
				id: run.id,
				createdAt,
				entries: entries.length,
				size: 0,
				storedSize: 0,
				outcomes: outcomesOf(run),
			});
		}
		const catalog: Catalog = {
			format: CATALOG_FORMAT,
			source: { kind: source.kind },
			entries,
		};
		const { object: catalogObject } = await store(
			run,
			'catalog.age',
			bytes(JSON.stringify(catalog)),
		);
		const manifest: Manifest = {
			format: MANIFEST_FORMAT,
			backup: ctx.backup,
			id: run.id,
			createdAt: createdAt.toISOString(),
			kind: 'full',
			parent: null,
			recipients: [...ctx.recipients],
			compression: 'zstd',
			catalog: catalogObject,
			objects,
		};
		const manifestFile = join(folder, MANIFEST);
		await Bun.write(manifestFile, `${JSON.stringify(manifest, null, '\t')}\n`);
		await putAll(run, MANIFEST, manifestFile);
		return settle(run, {
			id: run.id,
			createdAt,
			entries: entries.length,
			size: entries.reduce((sum, entry) => sum + entry.size, 0),
			storedSize: [...objects, catalogObject].reduce(
				(sum, o) => sum + o.size,
				0,
			),
			outcomes: outcomesOf(run),
		});
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

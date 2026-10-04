import type { Decrypter } from 'age-encryption';
import { manifestIds } from '../backups/list';
import { type At, failure, fetchCatalog, fetchManifest } from '../backups/read';
import type { Run } from '../backups/run';
import { BackupError } from '../errors/backup-error';
import type { BackupKind, Manifest } from '../format/manifest';
import type { Repository } from '../repository/types';
import type { Since } from '../source/types';
import { chainOf } from './view';

/** An entry of the backup built on, and where its object is. */
export interface Known {
	size: number;
	sha256: string;
	fingerprint: string | undefined;
	/** The backup holding its object, and the object's key there. */
	in: string;
	object: string;
}

/** The backup a new one builds on, and what it recorded. */
export interface Base {
	manifest: Manifest;
	/** What the source is given. */
	since: Since;
	/** Its entries by name, with where each object is. */
	known: ReadonlyMap<string, Known>;
}

export interface BaseOptions {
	kind: Exclude<BackupKind, 'full'>;
	/** Where to look: the first repository still in the run by default. */
	from: string | undefined;
	decrypter: Decrypter;
	sourceKind: string;
	/** Where to stage the catalog. */
	path: string;
}

/**
 * The newest backup a `kind` backup builds on, in `repository`, older than
 * the new one: the newest readable one for an incremental, the newest
 * readable full one for a differential. One that does not read is passed
 * over, not built on.
 */
async function newestFor(
	run: Run,
	repository: Repository,
	kind: BaseOptions['kind'],
): Promise<Manifest> {
	const ids = (await manifestIds(run.ctx, repository)).filter(
		(id) => id < run.id,
	);
	for (const id of ids.reverse()) {
		try {
			const at: At = { call: 'create', id, repository };
			const manifest = await fetchManifest(run.ctx, at);
			if (kind === 'incremental' || manifest.kind === 'full') return manifest;
		} catch (error) {
			if (!(error instanceof BackupError)) throw error;
		}
	}
	throw new BackupError(
		`create on "${run.ctx.backup}": no ${kind === 'differential' ? 'full ' : ''}` +
			`backup to build on (repository "${repository.name}")`,
		{
			code: 'NOT_FOUND',
			backup: run.ctx.backup,
			id: run.id,
			repository: repository.name,
		},
	);
}

/**
 * Leaves out of the run every other repository that does not hold the
 * whole chain of `base`: a backup built on one it lacks could not be
 * restored from there.
 */
async function requireEverywhere(
	run: Run,
	base: Manifest,
	from: Repository,
): Promise<void> {
	await Promise.all(
		run.ctx.repositories
			.filter((r) => r !== from && !run.failed.has(r.name))
			.map(async (repository) => {
				const at: At = { call: 'create', id: base.id, repository };
				try {
					await chainOf(run.ctx, at, await fetchManifest(run.ctx, at));
				} catch (error) {
					run.failed.set(
						repository.name,
						error instanceof BackupError && error.code === 'NOT_FOUND'
							? failure(
									run.ctx,
									{ ...at, id: run.id },
									'NOT_FOUND',
									'the backup it builds on is not in this repository',
								)
							: error,
					);
				}
			}),
	);
}

/** The repository to read the base from: `from`, or the first still in the run. */
function sourceRepository(run: Run, from: string | undefined): Repository {
	const named =
		from === undefined
			? run.ctx.repositories.find((r) => !run.failed.has(r.name))
			: run.ctx.repositories.find((r) => r.name === from);
	if (!named) {
		throw new TypeError(
			`create on "${run.ctx.backup}": no repository has that name`,
		);
	}
	// Read without its lock, a prune could remove the base mid-read.
	if (run.failed.has(named.name)) throw run.failed.get(named.name);
	return named;
}

function sameRecipients(a: readonly string[], b: readonly string[]): boolean {
	const set = new Set(a);
	return set.size === new Set(b).size && b.every((r) => set.has(r));
}

/**
 * Finds the backup a new one builds on, checks its whole chain is there,
 * and reads its catalog: what the source gets as `since`, and where each
 * entry's object already is. A base encrypted to other recipients is
 * refused: pointing to its objects would keep a removed key able to read
 * the new backup, and a new one unable to.
 */
export async function baseOf(run: Run, options: BaseOptions): Promise<Base> {
	const repository = sourceRepository(run, options.from);
	const manifest = await newestFor(run, repository, options.kind);
	const at: At = { call: 'create', id: manifest.id, repository };
	await chainOf(run.ctx, at, manifest);
	if (!sameRecipients(manifest.recipients, run.ctx.recipients)) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the backup it builds on is encrypted ` +
				'to other recipients; make a full backup first',
		);
	}
	const catalog = await fetchCatalog(
		run.ctx,
		at,
		manifest,
		options.decrypter,
		options.path,
	);
	if (catalog.source.kind !== options.sourceKind) {
		throw new TypeError(
			`create on "${run.ctx.backup}": the source is not of the kind the ` +
				'backup it builds on was made from',
		);
	}
	await requireEverywhere(run, manifest, repository);
	const entries = new Map<string, Known>(
		catalog.entries.map((entry) => [
			entry.name,
			{
				size: entry.size,
				sha256: entry.sha256,
				fingerprint: entry.fingerprint,
				in: entry.in ?? manifest.id,
				object: entry.object,
			},
		]),
	);
	return {
		manifest,
		since: {
			id: manifest.id,
			position: catalog.position,
			// What a source may see: not where the objects are.
			entries: new Map(
				[...entries].map(([name, k]) => [
					name,
					{ size: k.size, sha256: k.sha256, fingerprint: k.fingerprint },
				]),
			),
		},
		known: entries,
	};
}

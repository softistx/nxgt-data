import { type BackupContext, keyOf, repositoryOf } from '../backups/context';
import { type At, fetchManifest, MANIFEST } from '../backups/read';
import { BackupError } from '../errors/backup-error';
import { upTo } from '../files/streams';
import { isBackupId, timeOfId } from '../format/ids';
import { MANIFEST_MAX_BYTES } from '../format/manifest';
import type { Lease } from '../lock/lock';
import { leaseLost, withLock } from '../lock/run-locks';
import type { Repository } from '../repository/types';
import { heldIds } from './holds';
import {
	type Candidate,
	checkPolicy,
	type Decision,
	type KeepPolicy,
	plan,
} from './policy';

export interface PruneOptions {
	/** The repository to prune, by name. The first one by default. */
	from?: string | undefined;
	/** What to keep; everything else goes. At least one rule. */
	keep: KeepPolicy;
	/** Say what would go, and why, and remove nothing. Takes no lock. */
	dryRun?: boolean | undefined;
	/**
	 * How old, in milliseconds, a backup with no manifest must be before it
	 * is removed: one still being written has none either. Its age counts
	 * from when its create **started** — the time in its id — by this
	 * machine's clock, whatever `now` says: so this must exceed your longest
	 * create, plus two leases for a write under way when a lease ran out.
	 * One day by default, and two leases at least.
	 */
	incompleteAfter?: number | undefined;
	/** The moment the policy is applied at. Now by default. */
	now?: Date | undefined;
}

/** What `prune` removed — or, with `dryRun`, would remove. */
export interface Pruned {
	repository: string;
	dryRun: boolean;
	/** Newest first, each with the rules that keep it. */
	kept: Decision[];
	/** Newest first, each with why it goes. */
	removed: Decision[];
	/** Ids that never got a manifest, old enough to go. */
	incomplete: string[];
	/** Ids whose manifest does not read: never removed, see `verify`. */
	unreadable: string[];
	/** `keep.maxTotalSize` is set, and what is kept is still over it. */
	overSize: boolean;
}

const DAY = 86_400_000;

/** Every key under `<backup>/`, grouped by backup id. */
async function scan(
	ctx: BackupContext,
	repository: Repository,
): Promise<Map<string, string[]>> {
	const prefix = `${ctx.backup}/`;
	const byId = new Map<string, string[]>();
	for await (const key of repository.list(prefix)) {
		const id = key.slice(prefix.length).split('/')[0] as string;
		if (!isBackupId(id)) continue;
		const keys = byId.get(id) ?? [];
		keys.push(key);
		byId.set(id, keys);
	}
	return byId;
}

/**
 * The `parent` an unreadable manifest names, read from its raw bytes, or
 * nothing. Untrusted — the manifest did not read, or was not signed — but
 * it only ever keeps more: a backup this version cannot read, or one a
 * newer kind made, must not lose what it builds on.
 */
async function parentOfUnreadable(
	ctx: BackupContext,
	repository: Repository,
	id: string,
): Promise<string | undefined> {
	const stream = await repository.get(keyOf(ctx, id, MANIFEST));
	if (!stream) return undefined;
	try {
		const value: unknown = JSON.parse(
			new TextDecoder().decode(await upTo(stream, MANIFEST_MAX_BYTES)),
		);
		const parent = (value as { parent?: unknown } | null)?.parent;
		return isBackupId(parent) && parent < id ? parent : undefined;
	} catch {
		return undefined;
	}
}

async function candidatesOf(
	ctx: BackupContext,
	repository: Repository,
	ids: readonly string[],
	held: ReadonlySet<string>,
): Promise<{ candidates: Candidate[]; unreadable: string[] }> {
	const candidates: Candidate[] = [];
	const unreadable: string[] = [];
	for (const id of ids) {
		const at: At = { call: 'prune', id, repository };
		try {
			const manifest = await fetchManifest(ctx, at);
			candidates.push({
				id,
				createdAt: new Date(manifest.createdAt),
				storedSize: [manifest.catalog, ...manifest.objects].reduce(
					(sum, o) => sum + o.size,
					0,
				),
				parent: manifest.parent,
				held: held.has(id),
			});
		} catch (error) {
			if (!(error instanceof BackupError)) throw error;
			if (error.code === 'NOT_FOUND') continue;
			if (error.code !== 'INTEGRITY' && error.code !== 'SIGNATURE') throw error;
			unreadable.push(id);
			// Stands in for it, held, so that the plan keeps its parent.
			candidates.push({
				id,
				createdAt: timeOfId(id),
				storedSize: 0,
				parent: (await parentOfUnreadable(ctx, repository, id)) ?? null,
				held: true,
				standIn: true,
			});
		}
	}
	return { candidates, unreadable };
}

function checkOptions(ctx: BackupContext, options: PruneOptions): number {
	checkPolicy(options.keep, `prune on "${ctx.backup}"`);
	if (
		options.now !== undefined &&
		!(options.now instanceof Date && !Number.isNaN(options.now.getTime()))
	) {
		throw new TypeError(`prune on "${ctx.backup}": now must be a valid Date`);
	}
	const after = options.incompleteAfter ?? DAY;
	if (!Number.isSafeInteger(after) || after < 2 * ctx.lease) {
		throw new TypeError(
			`prune on "${ctx.backup}": incompleteAfter must be a whole number of ` +
				'milliseconds, two lock leases at least',
		);
	}
	return after;
}

/**
 * Removes one backup: its manifest first, so it stops existing before any
 * object goes, then whatever else is under its id. Checks the lease before
 * each delete: one that ran out stops the prune.
 */
async function removeBackup(
	ctx: BackupContext,
	repository: Repository,
	lease: Lease,
	id: string,
	keys: readonly string[],
): Promise<void> {
	const manifest = `${ctx.backup}/${id}/${MANIFEST}`;
	const ordered = [
		...keys.filter((k) => k === manifest),
		...keys.filter((k) => k !== manifest),
	];
	for (const key of ordered) {
		if (!lease.held()) throw leaseLost(ctx, 'prune', id, repository.name);
		await repository.delete(key);
	}
}

/**
 * Applies `keep` to one repository: reads every manifest — no key needed —
 * plans what stays and what goes, and, unless `dryRun`, removes the rest
 * under the lock, with every backup that never got a manifest and is older
 * than `incompleteAfter`. A held backup, one a kept backup builds on, and
 * one whose manifest does not read are never removed.
 */
export async function pruneBackups(
	ctx: BackupContext,
	options: PruneOptions,
): Promise<Pruned> {
	const incompleteAfter = checkOptions(ctx, options);
	const repository = repositoryOf(ctx, options.from, 'prune');
	const now = options.now ?? new Date();
	const decide = async () => {
		const byId = await scan(ctx, repository);
		const complete = [...byId.keys()].filter((id) =>
			byId.get(id)?.includes(`${ctx.backup}/${id}/${MANIFEST}`),
		);
		const held = await heldIds(ctx, repository);
		const { candidates, unreadable } = await candidatesOf(
			ctx,
			repository,
			complete.sort(),
			held,
		);
		const incomplete = [...byId.keys()]
			.filter((id) => !complete.includes(id))
			.filter((id) => Date.now() - timeOfId(id).getTime() >= incompleteAfter)
			.sort();
		const planned = plan(candidates, options.keep, now);
		const shown = (d: Decision) => !unreadable.includes(d.id);
		return {
			byId,
			unreadable,
			incomplete,
			kept: planned.kept.filter(shown),
			removed: planned.removed.filter(shown),
			overSize: planned.overSize,
		};
	};
	const result = (d: Awaited<ReturnType<typeof decide>>, dryRun: boolean) => ({
		repository: repository.name,
		dryRun,
		kept: d.kept,
		removed: d.removed,
		incomplete: d.incomplete,
		unreadable: d.unreadable,
		overSize: d.overSize,
	});
	if (options.dryRun) return result(await decide(), true);
	return withLock(ctx, repository, 'prune', 'prune', async (lease) => {
		const decided = await decide();
		for (const id of [
			...decided.removed.map((d) => d.id),
			...decided.incomplete,
		]) {
			await removeBackup(
				ctx,
				repository,
				lease,
				id,
				decided.byId.get(id) ?? [],
			);
		}
		return result(decided, false);
	});
}

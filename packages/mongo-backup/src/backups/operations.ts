import {
	type BackupDefinition,
	type BackupInfo,
	type BoundBackup,
	bindBackup,
	type Repository,
	type Restored,
} from '@nxgt/backup';
import { MongoBackupError, renamed } from '../errors';
import type { RestoredCollections } from '../restore/options';
import { restoreSome } from '../restore/restore-collections';
import { mongoSource } from '../source/mongo-source';
import { mongoTarget } from '../target/mongo-target';
import { type BackupKeys, readKeyFile } from './key-file';
import {
	checkRestore,
	DEFAULT_FULL_EVERY,
	DEFAULT_KEEP,
	type MongoBackupsOptions,
	type RestoreAtOptions,
} from './options';
import { chosenBackup, countsOf, type DrillReport, kindFor } from './plan';

/** What one `run` did, for the logs: ids and sizes, never a key nor a document. */
export interface RunReport {
	id: string;
	kind: 'full' | 'incremental';
	/** `true` when an incremental was due, but the oplog no longer reached the last backup. */
	fellBack: boolean;
	entries: number;
	storedSize: number;
	/** How many backups a restore of this one reads: itself and those it builds on. */
	chain: number;
	/** The backups the rotation removed. */
	removed: string[];
}

/** What `restore` wrote: `collections` only when part of a backup was asked for. */
export type RestoreReport = Restored & {
	collections?: RestoredCollections['collections'];
};

export interface Bound {
	backups: BoundBackup;
	keys: BackupKeys;
}

/** What each operation reads: data only, the binding once the key file is read. */
export interface Context {
	options: MongoBackupsOptions;
	definition: BackupDefinition;
	repositories: readonly [Repository, ...Repository[]];
	/** The key file read and the backup bound, once a call needed them. */
	ready?: Promise<Bound> | undefined;
}

/** `<call> on "<backup>"`: the call a consumer wrote, and the backup it was on. */
const named = (ctx: Context, call: string) =>
	`${call} on "${ctx.definition.name}"`;

/** `p`'s lower-level refusals told as `<call> on "<backup>"`. */
export function asCalled<T>(
	p: Promise<T>,
	ctx: Context,
	call: string,
): Promise<T> {
	return renamed(p, named(ctx, call));
}

/** The binding, the key file read on first use, and again after a failed read. */
export function bindingOf(ctx: Context): Promise<Bound> {
	if (!ctx.ready) {
		const { options } = ctx;
		const ready = readKeyFile(options.keyFile, named(ctx, 'mongoBackups')).then(
			(keys) => ({
				keys,
				backups: bindBackup(ctx.definition, {
					repositories: ctx.repositories,
					recipients: [keys.recipient],
					signing: { key: keys.signingKey },
					tmpDir: options.tmpDir,
				}),
			}),
		);
		// A failed read is tried again next call: the file may be fixed by then.
		ready.catch(() => {
			if (ctx.ready === ready) ctx.ready = undefined;
		});
		ctx.ready = ready;
	}
	return ctx.ready;
}

/** The backups the repository holds that read with the key, oldest first. */
export async function listOf(ctx: Context): Promise<BackupInfo[]> {
	return (await (await bindingOf(ctx)).backups.list()).backups;
}

/**
 * One scheduled run: a full backup when none is younger than `fullEvery`,
 * an incremental otherwise — a full one after all when the oplog no longer
 * reaches the last backup, since every incremental would fail alike until
 * one — read back with the key, then the rotation.
 */
export async function runOnce(
	ctx: Context,
	now = new Date(),
): Promise<RunReport> {
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
		throw new TypeError(`${named(ctx, 'run')}: now must be a valid Date`);
	}
	const { options } = ctx;
	const { backups, keys } = await bindingOf(ctx);
	const identities = [keys.identity];
	const source = () =>
		mongoSource({ db: options.db, collections: options.collections });
	const due = kindFor(
		await listOf(ctx),
		now,
		options.fullEvery ?? DEFAULT_FULL_EVERY,
	);
	let fellBack = false;
	const created =
		due === 'full'
			? await backups.create(source())
			: await backups
					.create(source(), { kind: 'incremental', identities })
					.catch((error: unknown) => {
						if (!(error instanceof MongoBackupError)) throw error;
						if (error.code !== 'HISTORY_LOST') throw error;
						fellBack = true;
						return backups.create(source());
					});
	const verified = await backups.verify(created.id, { identities });
	const keep = options.keep ?? DEFAULT_KEEP;
	// Not `now`: backups carry the machine's time, so a later `now` would
	// rotate away the backup just made.
	const removed = keep === false ? [] : (await backups.prune({ keep })).removed;
	return {
		id: created.id,
		kind: created.kind === 'full' ? 'full' : 'incremental',
		fellBack,
		entries: created.entries,
		storedSize: created.storedSize,
		chain: verified.chain.length,
		removed: removed.map((decision) => decision.id),
	};
}

/**
 * The backup `at.at` names, into `at.into`: whole through `mongoTarget`,
 * or the part the options name through `restoreCollections`.
 */
export async function restoreAt(
	ctx: Context,
	at: RestoreAtOptions,
): Promise<RestoreReport> {
	const where = named(ctx, 'restore');
	checkRestore(at, where);
	const { tmpDir } = ctx.options;
	const { backups, keys } = await bindingOf(ctx);
	const id = chosenBackup(await listOf(ctx), at.at, where);
	const identities = [keys.identity];
	const part =
		at.collections !== undefined ||
		at.as !== undefined ||
		at.documents !== undefined;
	if (!part) {
		return backups.restore(
			id,
			mongoTarget({ db: at.into, replace: at.replace, tmpDir }),
			{ identities },
		);
	}
	return restoreSome(
		backups,
		id,
		{
			identities,
			db: at.into,
			collections: at.collections,
			as: at.as,
			tmpDir,
			...(at.documents === undefined
				? { replace: at.replace }
				: { documents: at.documents }),
		},
		where,
	);
}

/** The newest backup, chain included, into a database of its own, counted, dropped. */
export async function drillNewest(ctx: Context): Promise<DrillReport> {
	const { db, tmpDir } = ctx.options;
	const { backups, keys } = await bindingOf(ctx);
	const id = chosenBackup(await listOf(ctx), undefined, named(ctx, 'drill'));
	const drill = db.client.db(`nxgt-drill-${crypto.randomUUID()}`);
	try {
		await backups.restore(id, mongoTarget({ db: drill, tmpDir }), {
			identities: [keys.identity],
		});
		return { id, collections: await countsOf(drill) };
	} finally {
		await drill.dropDatabase().catch(() => undefined);
	}
}

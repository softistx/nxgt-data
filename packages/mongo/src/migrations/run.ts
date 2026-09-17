import type { ClientSession, Db } from 'mongodb';
import { withTransaction } from '../transaction/with-transaction';
import { MigrationError } from './errors';
import { checkLock, withLock } from './lock';
import { checkList, statusOf, toApply, toRevert } from './plan';
import {
	ensureRecords,
	type MigrationStore,
	readRecords,
	removeRecord,
	storeOf,
	writeRecord,
} from './store';
import type {
	MigrateOptions,
	MigrateResult,
	Migration,
	MigrationRun,
	MigrationStatus,
	MigrationStep,
	MigrationStoreOptions,
	RollbackOptions,
	RollbackResult,
} from './types';

/** What a step writes about itself, in its session: its record, or not. */
type Bookkeeping = (
	session: ClientSession | undefined,
	durationMs: number,
) => Promise<void>;

function failed(migration: Migration, direction: string, error: unknown) {
	const kept = migration.transaction
		? 'nothing it did was kept'
		: 'it ran without a transaction, so what it did before failing stays';
	const reason = error instanceof Error ? error.message : String(error);
	return new MigrationError(
		`Migration "${migration.id}" failed ${direction}, and ${kept}: ${reason}`,
		{ migration: migration.id, cause: error },
	);
}

/**
 * One step and its record, together: in one transaction, or one after the
 * other when the migration runs without.
 */
async function runStep(
	store: MigrationStore,
	migration: Migration,
	direction: 'up' | 'down',
	step: MigrationStep,
	bookkeeping: Bookkeeping,
): Promise<MigrationRun> {
	const { db } = store;
	const started = performance.now();
	const elapsed = () => Math.round(performance.now() - started);
	const once = async (session: ClientSession | undefined) => {
		await step({ db, client: db.client, session });
		await bookkeeping(session, elapsed());
	};
	try {
		if (migration.transaction) await withTransaction(db.client, once);
		else await once(undefined);
	} catch (error) {
		throw failed(migration, direction, error);
	}
	return { id: migration.id, durationMs: elapsed() };
}

/**
 * Applies the migrations of the list that are not recorded yet, in the
 * list's order, holding the lock. The list is checked against what is
 * recorded first: it must have only grown at its end.
 *
 * ```ts
 * await migrate(db, [createSlugs, backfillSlug]);
 * ```
 *
 * It stops at the first failure, which is a `MigrationError`; the ones
 * before it stay applied.
 */
export async function migrate(
	db: Db,
	migrations: readonly Migration[],
	options: MigrateOptions = {},
): Promise<MigrateResult> {
	checkList(migrations);
	const store = storeOf(db, options);
	if (options.dryRun) {
		const plan = toApply(migrations, await readRecords(store), options.to);
		return { applied: [], pending: plan.map((m) => m.id) };
	}
	await ensureRecords(store);
	return withLock(store, async (lock) => {
		const plan = toApply(migrations, await readRecords(store), options.to);
		const applied: MigrationRun[] = [];
		for (const migration of plan) {
			checkLock(store, lock);
			const record: Bookkeeping = (session, durationMs) =>
				writeRecord(store, migration.id, session, durationMs);
			applied.push(await runStep(store, migration, 'up', migration.up, record));
		}
		return { applied, pending: [] };
	});
}

/**
 * Undoes the last applied migration, or every one after `to`, the last
 * first. Refused before anything runs when one of them has no `down`.
 */
export async function rollback(
	db: Db,
	migrations: readonly Migration[],
	options: RollbackOptions = {},
): Promise<RollbackResult> {
	checkList(migrations);
	const store = storeOf(db, options);
	if (options.dryRun) {
		const plan = toRevert(migrations, await readRecords(store), options.to);
		return { reverted: [], pending: plan.map((r) => r.migration.id) };
	}
	await ensureRecords(store);
	return withLock(store, async (lock) => {
		const plan = toRevert(migrations, await readRecords(store), options.to);
		const reverted: MigrationRun[] = [];
		for (const { migration, down } of plan) {
			checkLock(store, lock);
			const unrecord: Bookkeeping = (session) =>
				removeRecord(store, migration.id, session);
			reverted.push(await runStep(store, migration, 'down', down, unrecord));
		}
		return { reverted, pending: [] };
	});
}

/**
 * Every migration of the list, applied or pending, and every recorded one
 * the list no longer has. It reports rather than refuses: `migrate` is what
 * refuses a list that does not match.
 */
export async function migrationStatus(
	db: Db,
	migrations: readonly Migration[],
	options: MigrationStoreOptions = {},
): Promise<MigrationStatus[]> {
	checkList(migrations);
	const store = storeOf(db, options);
	return statusOf(migrations, await readRecords(store));
}

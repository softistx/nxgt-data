import type { ClientSession, Collection, Db } from 'mongodb';
import { toDataError } from '../errors/to-data-error';
import type { MigrationRecord, MigrationStoreOptions } from './types';

export const DEFAULT_COLLECTION = 'nxgt_migrations';
export const DEFAULT_LOCK_TTL_MS = 60_000;

/** Where a run reads and writes: data only, resolved once. */
export interface MigrationStore {
	readonly db: Db;
	readonly records: Collection<MigrationRecord>;
	readonly lockName: string;
	readonly lockTtlMs: number;
}

export function storeOf(
	db: Db,
	options: MigrationStoreOptions,
): MigrationStore {
	const name = options.collection ?? DEFAULT_COLLECTION;
	const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
	if (!Number.isInteger(lockTtlMs) || lockTtlMs < 1000) {
		throw new TypeError(
			`migrations: lockTtlMs must be a whole number of milliseconds, at least 1000, not ${String(lockTtlMs)}`,
		);
	}
	return {
		db,
		records: db.collection<MigrationRecord>(name),
		lockName: `${name}_lock`,
		lockTtlMs,
	};
}

/** Runs a driver call, turning a MongoDB error into a `DataError`. */
export async function driver<T>(
	store: MigrationStore,
	fn: () => Promise<T>,
	collection = store.records.collectionName,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDataError(error, { collection });
	}
}

export function readRecords(store: MigrationStore): Promise<MigrationRecord[]> {
	return driver(store, () => store.records.find().toArray());
}

/**
 * Creates the records' collection before any transaction writes to it: a
 * transaction may create one implicitly, but not on every deployment.
 */
export async function ensureRecords(store: MigrationStore): Promise<void> {
	const name = store.records.collectionName;
	await driver(store, async () => {
		await store.db.createCollection(name).catch((error: { code?: number }) => {
			// NamespaceExists: an earlier run, or another one, created it.
			if (error.code !== 48) throw error;
		});
	});
}

export async function writeRecord(
	store: MigrationStore,
	id: string,
	session: ClientSession | undefined,
	durationMs: number,
): Promise<void> {
	await store.records.insertOne(
		{ _id: id, appliedAt: new Date(), durationMs },
		session ? { session } : {},
	);
}

export async function removeRecord(
	store: MigrationStore,
	id: string,
	session: ClientSession | undefined,
): Promise<void> {
	await store.records.deleteOne({ _id: id }, session ? { session } : {});
}

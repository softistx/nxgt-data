import type { ClientSession, Db, MongoClient } from 'mongodb';

/**
 * What a migration is handed. `session` is the transaction's, and **every
 * operation has to be given it** to be part of it — MongoDB has no ambient
 * session. It is `undefined` for a migration run with `transaction: false`.
 */
export interface MigrationContext {
	db: Db;
	client: MongoClient;
	session: ClientSession | undefined;
}

export type MigrationStep = (context: MigrationContext) => Promise<void>;

export interface MigrationConfig {
	/**
	 * What the migration is recorded under, once and for good: renaming it
	 * makes it a new migration. A date prefix keeps a list readable —
	 * `'2026-09-17-backfill-slug'` — but the order is the list's, not the
	 * id's.
	 */
	id: string;
	/** What it does. Run in a transaction unless `transaction` is `false`. */
	up: MigrationStep;
	/** How to undo it, for `rollback`. A migration without one cannot be. */
	down?: MigrationStep;
	/**
	 * `false` for what a transaction cannot hold: an index build, `collMod`,
	 * dropping a collection, or a write too large for one. Such a migration
	 * that fails half-way stays half-done, and is not recorded.
	 * Default `true`.
	 */
	transaction?: boolean;
}

export interface Migration {
	readonly id: string;
	readonly up: MigrationStep;
	readonly down: MigrationStep | undefined;
	readonly transaction: boolean;
}

/** Where the migrations are recorded, and how long a run holds its lock. */
export interface MigrationStoreOptions {
	/**
	 * The collection the applied migrations are recorded in. The lock lives
	 * beside it, in `<collection>_lock`. Default `'nxgt_migrations'`.
	 */
	collection?: string;
	/**
	 * How long the lock is held without news, in milliseconds. A run renews it
	 * while it works, so this is how long a crashed run blocks the next one.
	 * Default 60 000.
	 */
	lockTtlMs?: number;
}

export interface MigrateOptions extends MigrationStoreOptions {
	/** Apply up to and including this one, rather than all of them. */
	to?: string;
	/** Report what would run, without running it or taking the lock. */
	dryRun?: boolean;
}

export interface RollbackOptions extends MigrationStoreOptions {
	/**
	 * Undo every migration applied after this one, which stays applied.
	 * Without it, only the last applied one is undone.
	 */
	to?: string;
	/** Report what would be undone, without undoing it. */
	dryRun?: boolean;
}

/** One migration a run went through. */
export interface MigrationRun {
	id: string;
	durationMs: number;
}

export interface MigrateResult {
	/** What ran, in order: nothing on a dry run. */
	applied: MigrationRun[];
	/** What a dry run would have run, in order: nothing otherwise. */
	pending: string[];
}

export interface RollbackResult {
	/** What was undone, in the order it was: the last applied first. */
	reverted: MigrationRun[];
	/** What a dry run would have undone, in order. */
	pending: string[];
}

/**
 * - `applied`: recorded, and in the list.
 * - `pending`: in the list, not recorded.
 * - `missing`: recorded, and no longer in the list — the list lost it.
 */
export type MigrationState = 'applied' | 'pending' | 'missing';

export interface MigrationStatus {
	id: string;
	state: MigrationState;
	appliedAt: Date | undefined;
}

/** How a migration is recorded. */
export interface MigrationRecord {
	_id: string;
	appliedAt: Date;
	durationMs: number;
}

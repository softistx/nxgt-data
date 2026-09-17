import { DataError, type DataErrorOptions } from '../errors/data-error';

/**
 * A migration failed, or the list cannot be run against what is recorded:
 * an id twice, one recorded and no longer listed, one listed before an
 * applied one it was not applied before.
 */
export class MigrationError extends DataError {
	override name = 'MigrationError';
	override readonly code = 'MIGRATION' as const;
	/** The migration it is about, when it is about one. */
	readonly migration: string | undefined;

	constructor(
		message = 'Migration failed',
		options: DataErrorOptions & { migration?: string | undefined } = {},
	) {
		super(message, options);
		this.migration = options.migration;
	}
}

/** Another run holds the lock: two runs never migrate at once. */
export class MigrationLockedError extends DataError {
	override name = 'MigrationLockedError';
	override readonly code = 'MIGRATION_LOCKED' as const;
	/** Who holds it, as that run described itself. */
	readonly holder: string | undefined;
	/** When the lock lapses if its holder stops renewing it. */
	readonly expiresAt: Date | undefined;

	constructor(
		message = 'Migrations are locked by another run',
		options: DataErrorOptions & {
			holder?: string | undefined;
			expiresAt?: Date | undefined;
		} = {},
	) {
		super(message, options);
		this.holder = options.holder;
		this.expiresAt = options.expiresAt;
	}
}

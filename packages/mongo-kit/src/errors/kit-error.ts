/** What the kit refused, as a string a caller can switch on. */
export type KitErrorCode =
	/** The configuration object itself is wrong, and nothing connected. */
	| 'CONFIG'
	/** A collection is wired under a name that is a member of the driver's `Db`. */
	| 'COLLISION'
	/** A database was read by a name this kit does not hold. */
	| 'NO_DATABASE'
	/** `kit.db` was read on a kit that holds more than one database. */
	| 'SEVERAL_DATABASES'
	/** A transaction that cannot be opened: no client named, or already in one. */
	| 'TRANSACTION'
	/** `close()` on a kit that `as`, `withSession` or a transaction derived. */
	| 'DERIVED'
	/** `discoverCollections` could not make a set of definitions from a glob. */
	| 'DISCOVERY';

export interface KitErrorOptions {
	/** The database it is about, when one is named. */
	database?: string | undefined;
	/** The config key, the collection key or the path it is about. */
	key?: string | undefined;
	cause?: unknown;
}

/**
 * What this package refuses, with a code beside the sentence.
 *
 * It extends `TypeError` rather than `Error`, unlike `DataError`,
 * `RedisError` and `S3Error`: every one of these is a call or a
 * configuration written wrong, which is what `TypeError` means, and this
 * package threw bare `TypeError`s before it existed. Extending one keeps
 * every `catch` that tests for `TypeError` working, and adds a `code` to
 * switch on instead of matching the message text.
 */
export class KitError extends TypeError {
	override name = 'KitError';
	readonly code: KitErrorCode;
	readonly database: string | undefined;
	readonly key: string | undefined;

	constructor(code: KitErrorCode, message: string, options?: KitErrorOptions) {
		super(message, { cause: options?.cause });
		this.code = code;
		this.database = options?.database;
		this.key = options?.key;
	}
}

/** What went wrong, as a string a caller can switch on. */
export type DataErrorCode =
	| 'DATABASE'
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'VALIDATION'
	| 'OPTIMISTIC_LOCK'
	| 'INVALID_CURSOR'
	| 'INVALID_ID'
	| 'CORRUPT_FILE'
	| 'MIGRATION'
	| 'MIGRATION_LOCKED'
	| 'CONNECTION';

/** One reason a document failed the collection's `$jsonSchema` validator. */
export interface ValidationIssue {
	/** The dotted path of the field, empty for the document itself. */
	path: string;
	/** The rule it broke: `bsonType`, `required`, `minimum`… */
	reason: string;
	/** What the schema asked for, as MongoDB reports it. */
	specifiedAs?: unknown;
	/** The value that was refused, when the server names it. */
	consideredValue?: unknown;
	/** Its BSON type, when the server names it: `string`, `int`, `double`… */
	consideredType?: string;
	/** The schema's `description` for the field, when it has one. */
	description?: string;
}

export interface DataErrorOptions {
	collection?: string | undefined;
	/** The `_id` a method by id was given. */
	id?: unknown;
	/** MongoDB's numeric error code: 11000, 121, 26… */
	serverCode?: number | undefined;
	/** MongoDB's `codeName`, which only `find` and `findAndModify` answers carry. */
	serverCodeName?: string | undefined;
	/** The index a conflict names, when the server names one. */
	index?: string | undefined;
	/** The fields the error is about: an index's keys, or a validator's paths. */
	keys?: string[];
	/** Those fields' values, when the server gives them. */
	values?: Record<string, unknown> | undefined;
	issues?: ValidationIssue[];
	expectedVersion?: number | undefined;
	actualVersion?: number | undefined;
	cause?: unknown;
}

/**
 * What this package throws. Every method turns a driver error into one of
 * these, so an application catches `ConflictError` instead of reading `11000`
 * off an error whose shape changes with the operation that produced it.
 *
 * A driver error that is none of them reaches the caller as it is.
 */
export class DataError extends Error {
	override name = 'DataError';
	readonly code: DataErrorCode = 'DATABASE';
	readonly collection: string | undefined;
	readonly id: unknown;
	readonly serverCode: number | undefined;
	readonly serverCodeName: string | undefined;
	readonly index: string | undefined;
	readonly keys: string[];
	readonly values: Record<string, unknown> | undefined;
	readonly issues: ValidationIssue[];
	readonly expectedVersion: number | undefined;
	readonly actualVersion: number | undefined;

	constructor(message = 'Database error', options: DataErrorOptions = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.collection = options.collection;
		this.id = options.id;
		this.serverCode = options.serverCode;
		this.serverCodeName = options.serverCodeName;
		this.index = options.index;
		this.keys = options.keys ?? [];
		this.values = options.values;
		this.issues = options.issues ?? [];
		this.expectedVersion = options.expectedVersion;
		this.actualVersion = options.actualVersion;
	}
}

/**
 * A stored file is missing chunks.
 *
 * GridFS keeps a file's bytes in a second collection, and nothing in MongoDB
 * ties the two together: a chunk removed by hand, an interrupted write from
 * another client, or a restore of one collection without the other leaves a
 * file whose `length` promises bytes that are not there. It is raised while
 * the bytes are being read, not when the file is found.
 */
export class CorruptFileError extends DataError {
	override name = 'CorruptFileError';
	override readonly code: DataErrorCode = 'CORRUPT_FILE';
}

/** No document matched, where one was required. */
export class NotFoundError extends DataError {
	override name = 'NotFoundError';
	override readonly code = 'NOT_FOUND' as const;

	constructor(message = 'Not found', options: DataErrorOptions = {}) {
		super(message, options);
	}
}

/** A unique index refused the write: MongoDB's `E11000`. */
export class ConflictError extends DataError {
	override name = 'ConflictError';
	override readonly code = 'CONFLICT' as const;

	constructor(message = 'Duplicate key', options: DataErrorOptions = {}) {
		super(message, { serverCode: 11000, ...options });
	}
}

/** The collection's `$jsonSchema` validator refused the document: code 121. */
export class ValidationError extends DataError {
	override name = 'ValidationError';
	override readonly code = 'VALIDATION' as const;

	constructor(
		message = 'Document failed validation',
		options: DataErrorOptions = {},
	) {
		super(message, { serverCode: 121, ...options });
	}
}

/**
 * The document changed since it was read: its `version` is no longer the one
 * the update expected, and nothing was written.
 */
export class OptimisticLockError extends DataError {
	override name = 'OptimisticLockError';
	override readonly code = 'OPTIMISTIC_LOCK' as const;

	constructor(message = 'Version conflict', options: DataErrorOptions = {}) {
		super(message, options);
	}
}

/**
 * A value that is not an `ObjectId` and not the string of one.
 *
 * It is a `DataError` rather than a `TypeError` because it is usually data,
 * not a mistake in the code: an id off a URL or a form reaches `toObjectId`,
 * and a handler wants to answer 400 or 404 rather than crash.
 */
export class InvalidIdError extends DataError {
	override name = 'InvalidIdError';
	override readonly code = 'INVALID_ID' as const;

	constructor(message = 'Invalid id', options: DataErrorOptions = {}) {
		super(message, options);
	}
}

/** A cursor this package did not write, or one for another ordering. */
export class InvalidCursorError extends DataError {
	override name = 'InvalidCursorError';
	override readonly code = 'INVALID_CURSOR' as const;

	constructor(message = 'Invalid cursor', options: DataErrorOptions = {}) {
		super(message, options);
	}
}

/**
 * The shared client was closed while this `connectMongo` was still waiting
 * for it.
 *
 * `closeMongo()` closes every client at once, so a connect that raced it
 * comes back holding nothing. Calling `connectMongo` again opens a fresh one;
 * the failure is the race, not the URI.
 *
 * MongoDB's own refusal to connect — a host that does not answer, an auth
 * failure — is the driver's error and reaches the caller unchanged. This is
 * only what *this* package decides. It carries no URI: a connection string
 * holds the password.
 */
export class ConnectionError extends DataError {
	override name = 'ConnectionError';
	override readonly code = 'CONNECTION' as const;

	constructor(message = 'Connection lost', options: DataErrorOptions = {}) {
		super(message, options);
	}
}

/** What went wrong, as a string a caller can switch on. */
export type DataErrorCode =
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'FOREIGN_KEY'
	| 'CHECK_VIOLATION'
	| 'NOT_NULL_VIOLATION'
	| 'INVALID_VALUE'
	| 'INVALID_CURSOR'
	| 'DATABASE';

export interface DataErrorOptions {
	/** The error this one was made from: the driver's, or Drizzle's around it. */
	cause?: unknown;
	/** The SQLSTATE the database answered with, such as `23505`. */
	sqlState?: string | undefined;
	/** The table the database named, if it named one. */
	table?: string | undefined;
	/** The constraint the database named, if it named one. */
	constraint?: string | undefined;
	/** The columns involved, as the database names them. */
	columns?: readonly string[] | undefined;
	/**
	 * The database's own detail line, such as
	 * `Key (email)=(ada@example.com) already exists.`. It can carry the value
	 * that was refused: log it, do not send it to a client.
	 */
	detail?: string | undefined;
}

/**
 * The base class of every error this package throws. `code` says which one,
 * and `cause` holds the error it was made from.
 */
export class DataError extends Error {
	override name = 'DataError';
	readonly code: DataErrorCode;
	readonly sqlState: string | undefined;
	readonly table: string | undefined;
	readonly constraint: string | undefined;
	readonly columns: readonly string[];
	readonly detail: string | undefined;

	constructor(
		message: string,
		options: DataErrorOptions & { code?: DataErrorCode } = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = options.code ?? 'DATABASE';
		this.sqlState = options.sqlState;
		this.table = options.table;
		this.constraint = options.constraint;
		this.columns = options.columns ?? [];
		this.detail = options.detail;
	}
}

/** No row matched: `getById`, `update(id)`, `delete(id)`, `restore(id)`. */
export class NotFoundError extends DataError {
	override name = 'NotFoundError';
	/** The id that was looked for, when the lookup was by id. */
	readonly id: unknown;

	constructor(
		message = 'Not found',
		options: Omit<DataErrorOptions, 'sqlState'> & { id?: unknown } = {},
	) {
		super(message, { ...options, code: 'NOT_FOUND' });
		this.id = options.id;
	}
}

/** A unique constraint refused the write: SQLSTATE `23505`. */
export class ConflictError extends DataError {
	override name = 'ConflictError';

	constructor(
		message = 'Unique constraint violated',
		options: DataErrorOptions = {},
	) {
		super(message, { sqlState: '23505', ...options, code: 'CONFLICT' });
	}
}

/**
 * A foreign key refused the write: SQLSTATE `23503`. Either the row it points
 * at does not exist, or a row still points at the one being deleted.
 */
export class ForeignKeyError extends DataError {
	override name = 'ForeignKeyError';

	constructor(
		message = 'Foreign key constraint violated',
		options: DataErrorOptions = {},
	) {
		super(message, { sqlState: '23503', ...options, code: 'FOREIGN_KEY' });
	}
}

/** A `CHECK` constraint refused the write: SQLSTATE `23514`. */
export class CheckViolationError extends DataError {
	override name = 'CheckViolationError';

	constructor(
		message = 'Check constraint violated',
		options: DataErrorOptions = {},
	) {
		super(message, { sqlState: '23514', ...options, code: 'CHECK_VIOLATION' });
	}
}

/** A `NOT NULL` column was given no value: SQLSTATE `23502`. */
export class NotNullViolationError extends DataError {
	override name = 'NotNullViolationError';

	constructor(
		message = 'Not-null constraint violated',
		options: DataErrorOptions = {},
	) {
		super(message, {
			sqlState: '23502',
			...options,
			code: 'NOT_NULL_VIOLATION',
		});
	}
}

/**
 * A value the database could not read as the column's type: SQLSTATE `22P02`
 * — `invalid input syntax for type uuid: "abc"` — and its neighbours `22001`
 * (too long for the column), `22003` (out of range), `22007` and `22008` (a
 * date or a time that is not one).
 *
 * Like `InvalidCursorError`, this is the caller's input rather than the
 * query's own doing, so a handler answers it with a 400. Without it, a `uuid`
 * path parameter that a client mistyped came back as a plain `DataError` with
 * `code: 'DATABASE'` — the same answer as a server that is down, which is a
 * 500. A division by zero (`22012`) is *not* one of these: that is the query,
 * not a value handed to it, and it stays a `DataError`.
 *
 * Measured on PGlite 0.5.8: every one of them carries the database's sentence
 * and nothing else — no `table`, no `column`, no `detail` — so `table` and
 * `columns` are empty here, unlike on a constraint violation. The sentence
 * can hold the value that was refused: log it, do not send it to a client.
 */
export class InvalidValueError extends DataError {
	override name = 'InvalidValueError';

	constructor(
		message = 'Invalid value for its type',
		options: DataErrorOptions = {},
	) {
		super(message, { ...options, code: 'INVALID_VALUE' });
	}
}

/**
 * A pagination cursor that this package did not write, or wrote for another
 * ordering. Usually a client's input: answer it with a 400.
 */
export class InvalidCursorError extends DataError {
	override name = 'InvalidCursorError';

	constructor(message = 'Invalid cursor', options: DataErrorOptions = {}) {
		super(message, { ...options, code: 'INVALID_CURSOR' });
	}
}

import {
	CheckViolationError,
	ConflictError,
	DataError,
	ForeignKeyError,
	InvalidValueError,
	NotNullViolationError,
} from './data-error';

/**
 * The fields a driver error carries, under either spelling: `node-postgres`
 * and PGlite write `constraint`, `postgres.js` writes `constraint_name`.
 */
interface DriverError {
	code: string;
	message?: string;
	detail?: string;
	table?: string;
	table_name?: string;
	column?: string;
	column_name?: string;
	constraint?: string;
	constraint_name?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The first error in the `cause` chain that carries a SQLSTATE. Drizzle wraps
 * the driver's error in a `DrizzleQueryError`, with the driver's as `cause`.
 */
function findDriverError(error: unknown): DriverError | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current; depth++) {
		if (typeof current !== 'object') return undefined;
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && SQLSTATE.test(code)) {
			return current as DriverError;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** `Key (a, b)=(1, 2) already exists.` → `['a', 'b']`. */
function columnsFromDetail(detail: string | undefined): string[] {
	const match = detail?.match(/^Key \((.+?)\)=/);
	if (!match?.[1]) return [];
	return match[1]
		.split(',')
		.map((column) => column.trim().replace(/^"|"$/g, ''));
}

/**
 * Turns a database error into this package's own: a unique violation into a
 * `ConflictError`, a foreign key into a `ForeignKeyError`, and so on. It reads
 * the SQLSTATE `code`, on the error or anywhere in its `cause` chain, so it
 * takes the driver's error and Drizzle's `DrizzleQueryError` around it alike.
 *
 * Any other error that carries a SQLSTATE becomes a plain `DataError` with
 * that `sqlState`. An error that carries none, such as a `TypeError`, or one
 * that is already a `DataError`, is returned as it is. So `throw
 * toDataError(error)` is always safe in a `catch`.
 *
 * The repository and `withTransaction` already do this.
 */
export function toDataError(error: unknown): unknown {
	if (error instanceof DataError) return error;
	const driver = findDriverError(error);
	if (!driver) return error;

	const table = driver.table ?? driver.table_name;
	const constraint = driver.constraint ?? driver.constraint_name;
	const column = driver.column ?? driver.column_name;
	const options = {
		cause: error,
		sqlState: driver.code,
		table,
		constraint,
		detail: driver.detail,
		columns: columnsFromDetail(driver.detail),
	};
	const on = table ? ` on "${table}"` : '';

	switch (driver.code) {
		case '23505':
			return new ConflictError(
				`Unique constraint${constraint ? ` "${constraint}"` : ''} violated${on}`,
				options,
			);
		case '23503':
			return new ForeignKeyError(
				`Foreign key${constraint ? ` "${constraint}"` : ''} violated${on}`,
				options,
			);
		case '23514':
			return new CheckViolationError(
				`Check constraint${constraint ? ` "${constraint}"` : ''} violated${on}`,
				options,
			);
		case '23502':
			return new NotNullViolationError(
				`Column${column ? ` "${column}"` : ''}${on} cannot be null`,
				{ ...options, columns: column ? [column] : [] },
			);
		// The value did not fit the column's type. The database's own sentence
		// is kept: measured on PGlite 0.5.8, these carry no `table` and no
		// `column`, so rewriting it would say less than it does.
		case '22P02':
		case '22001':
		case '22003':
		case '22007':
		case '22008':
			return new InvalidValueError(
				driver.message ?? `Invalid value (${driver.code})`,
				options,
			);
		default:
			return new DataError(driver.message ?? `Database error ${driver.code}`, {
				...options,
				code: 'DATABASE',
			});
	}
}

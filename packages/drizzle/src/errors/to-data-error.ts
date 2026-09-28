import {
	CheckViolationError,
	ConflictError,
	DataError,
	ForeignKeyError,
	InvalidValueError,
	NotNullViolationError,
} from './data-error';
import { findDriverError } from './driver-error';

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
 * the SQLSTATE — `code`, or Bun's `errno` — on the error or anywhere in its
 * `cause` chain, so it takes the driver's error and Drizzle's
 * `DrizzleQueryError` around it alike.
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

	const { sqlState, table, constraint, column } = driver;
	const options = {
		cause: error,
		sqlState,
		table,
		constraint,
		detail: driver.detail,
		columns: columnsFromDetail(driver.detail),
	};
	const on = table ? ` on "${table}"` : '';

	switch (sqlState) {
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
				driver.message ?? `Invalid value (${sqlState})`,
				options,
			);
		default:
			return new DataError(driver.message ?? `Database error ${sqlState}`, {
				...options,
				code: 'DATABASE',
			});
	}
}

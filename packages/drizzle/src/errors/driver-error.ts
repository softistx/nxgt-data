/**
 * What `toDataError` needs from a driver's error, read once whatever the
 * driver spelled it.
 */
export interface DriverError {
	sqlState: string;
	message: string | undefined;
	detail: string | undefined;
	table: string | undefined;
	constraint: string | undefined;
	column: string | undefined;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The field when it is a string, and nothing otherwise. */
function text(from: object, key: string): string | undefined {
	const value = (from as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}

/**
 * The SQLSTATE an error carries, if any. `node-postgres`, `postgres.js` and
 * PGlite put it in `code`. Bun's `SQL` puts `'ERR_POSTGRES_SERVER_ERROR'` in
 * `code` and the SQLSTATE in `errno` — measured on Bun 1.4.2 against
 * PostgreSQL 17 — so `errno` is read when `code` is not one.
 */
function sqlStateOf(error: object): string | undefined {
	for (const key of ['code', 'errno']) {
		const value = text(error, key);
		if (value !== undefined && SQLSTATE.test(value)) return value;
	}
	return undefined;
}

/**
 * The first error in the `cause` chain that carries a SQLSTATE, up to eight
 * links. Drizzle wraps the driver's error in a `DrizzleQueryError`, with the
 * driver's as `cause`.
 *
 * Both field spellings are read: `constraint`/`table`/`column`
 * (`node-postgres`, PGlite, Bun) and `constraint_name`/`table_name`/
 * `column_name` (`postgres.js`). Only strings are taken: on Bun, an error
 * whose server message names no column still has a `column` — the number of
 * the stack frame's column, measured as `27` on a unique violation.
 */
export function findDriverError(error: unknown): DriverError | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current; depth++) {
		if (typeof current !== 'object') return undefined;
		const sqlState = sqlStateOf(current);
		if (sqlState !== undefined) {
			return {
				sqlState,
				message: text(current, 'message'),
				detail: text(current, 'detail'),
				table: text(current, 'table') ?? text(current, 'table_name'),
				constraint:
					text(current, 'constraint') ?? text(current, 'constraint_name'),
				column: text(current, 'column') ?? text(current, 'column_name'),
			};
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

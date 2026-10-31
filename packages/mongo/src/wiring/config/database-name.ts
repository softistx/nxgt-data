import { WiringError } from '../../errors/wiring-error';

/** The databases MongoDB keeps for itself. */
const RESERVED = new Set(['admin', 'local', 'config']);

/** What a database name may not hold: MongoDB's list, Windows' included. */
const FORBIDDEN = /[/\\. "$*<>:|?\0]/;

/**
 * Refuses a database name MongoDB would refuse, or that is MongoDB's own.
 * `database(name)` runs at call time, on a name that may come from a request
 * (a tenant id), so the refusal has a code of its own, `DATABASE_NAME`. The
 * message says which rule was broken and never repeats the value.
 */
export function checkDatabaseName(name: unknown): asserts name is string {
	const refuse: (said: string) => never = (said) => {
		throw new WiringError('DATABASE_NAME', `database: the name ${said}.`);
	};
	if (typeof name !== 'string' || name.length === 0) {
		refuse('must be a non-empty string');
	}
	if (Buffer.byteLength(name) >= 64) refuse('must be under 64 bytes');
	if (FORBIDDEN.test(name)) {
		refuse('holds a character MongoDB refuses (one of /\\. "$*<>:|? or NUL)');
	}
	if (RESERVED.has(name)) {
		refuse("is one of MongoDB's own databases (admin, local, config)");
	}
}

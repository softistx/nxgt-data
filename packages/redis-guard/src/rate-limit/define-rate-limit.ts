import type { RateLimitDefinition } from './types';

/**
 * The longest a full bucket may take to refill from empty: ten years, in
 * milliseconds. The script keeps the bucket as a time in **microseconds**, in
 * a Lua double, which is exact up to 2^53 — about 285 years past the epoch.
 * Now plus ten years stays far inside that; a bound nobody would choose on
 * purpose keeps a typo (`per: 60e9`) from ever reaching the arithmetic.
 */
const MAX_REFILL = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * The shortest interval between requests, in microseconds: `per × 1000 ÷
 * limit` must be at least this. Near now (about 1.79e15 µs) a double resolves
 * only to 0.25 µs, so the TAT a request leaves would move by less than the
 * stored value can show, and a key's `PX` could round to 0, which Redis
 * refuses. At 2 µs, eight steps of a double, an interval is always visible
 * and `newTat - now` is always at least 2 µs, so the `PX` is at least 1 ms.
 * That is 500 requests a millisecond.
 */
const MIN_INTERVAL = 2;

const isCount = (n: unknown): n is number =>
	typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/**
 * The checks `defineRateLimit` makes, named after the call that made them —
 * `bindRateLimit` makes them too, for a definition written by hand.
 */
export function checkRateLimit<P>(
	definition: RateLimitDefinition<P>,
	call: string,
): void {
	const { name, limit, per, burst } = definition;
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError(`${call}: a rate limit needs a name, for its keys`);
	}
	if (typeof definition.key !== 'function') {
		throw new TypeError(
			`${call}: "${name}" has no key function; it builds the rest of the key from the params`,
		);
	}
	if (!isCount(limit)) {
		throw new TypeError(
			`${call}: "${name}" has a limit of ${limit}; it is a whole number of requests, and must be at least 1`,
		);
	}
	if (!isCount(per)) {
		throw new TypeError(
			`${call}: "${name}" has a per of ${per}; it is a whole number of milliseconds, and must be at least 1`,
		);
	}
	if (burst !== undefined && !isCount(burst)) {
		throw new TypeError(
			`${call}: "${name}" has a burst of ${burst}; it is a whole number of requests, and must be at least 1`,
		);
	}
	if ((per * 1000) / limit < MIN_INTERVAL) {
		throw new TypeError(
			`${call}: "${name}" has a limit of ${limit} per ${per}ms, more than 500 per millisecond; ` +
				'the script counts in microseconds, and needs at least 2 between requests',
		);
	}
	if (((burst ?? limit) * per) / limit > MAX_REFILL) {
		throw new TypeError(
			`${call}: "${name}" would take longer than ten years to refill from empty ` +
				'(burst × per ÷ limit); check that per is in milliseconds',
		);
	}
}

/**
 * Describes a rate limit. It talks to nothing: `bindRateLimit` is what needs
 * a client.
 *
 * ```ts
 * export const loginLimit = defineRateLimit({
 * 	name: 'login',
 * 	key: (p: { ip: string }) => p.ip,
 * 	limit: 5,
 * 	per: 60_000,                   // milliseconds
 * });
 * ```
 *
 * A definition that could never work is a bare `TypeError`, thrown here —
 * normally at import. Its values are the code's, not a request's, so the
 * message quotes them.
 */
export function defineRateLimit<P>(
	definition: RateLimitDefinition<P>,
): RateLimitDefinition<P> {
	checkRateLimit(definition, 'defineRateLimit');
	return Object.freeze({ ...definition });
}

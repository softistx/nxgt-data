import type { RateLimitDefinition } from './types';

/**
 * The most `burst × per` may be: the script counts in ticks of 1/limit µs, a
 * full bucket is `burst × per × 1000` of them, and a Lua number holds every
 * integer up to 2^53 − 1 exactly — `Number.MAX_SAFE_INTEGER`. The script
 * orders its arithmetic so that nothing it must hold exactly is larger than
 * that tolerance: the decision compares `cost × per × 1000` with what is
 * free, each at most the tolerance, rather than adding them. So the
 * tolerance itself is the bound, not twice it. `elapsed × limit` can be
 * larger, and is safe only because the script uses a stored state solely
 * when its `ahead` is at most the tolerance and both its fields at most
 * 2^53 − 1: the product is then compared with an exact integer its rounding
 * cannot pass. Every division's operands are held to 2^53 the same way.
 */
const MAX_BURST_PER = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/**
 * The longest a full bucket may take to refill from empty: ten years, in
 * milliseconds. Not for exactness — `MAX_BURST_PER` is that — but because
 * nobody means it: a bound nobody would choose on purpose catches `per`
 * written in microseconds (`per: 60e9`) before it limits anyone for decades.
 *
 * There is no bound on the rate itself. An earlier version refused more
 * than 500 requests a millisecond, because it kept time in a float of
 * microseconds that could not resolve less; in ticks every rate is exact.
 */
const MAX_REFILL = 10 * 365 * 24 * 60 * 60 * 1000;

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
	if ((burst ?? limit) * per > MAX_BURST_PER) {
		throw new TypeError(
			`${call}: "${name}" has a burst of ${burst ?? limit} and a per of ${per}ms; ` +
				`burst × per must be at most ${MAX_BURST_PER} for the script to count exactly`,
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

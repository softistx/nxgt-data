import { SearchIndexError } from '../errors/search-index-error';

/**
 * The run-time half of a token's `expiresAt`: the time is read **once**, into
 * whole seconds, those seconds are checked, and those same seconds are what
 * is signed. The SDK would otherwise call `getTime()` on the caller's object
 * again when it signs — measured on v1.53.2, a `Date` subclass whose
 * `getTime` changed between calls, or an object made to look like a `Date`,
 * signed an `exp` of `null` or of 10^17, which the server takes as no expiry.
 */

// A time in seconds past this is a time in milliseconds: 10^11 seconds is
// the year 5138, and `Date.now()` has been past 10^12 since 2001.
const MAX_SECONDS = 1e11;

/** The intrinsic: it reads a real `Date`'s time, and throws on anything else. */
const timeOf = Date.prototype.getTime;

/** The seconds to sign, or why `expiresAt` cannot be signed. */
function secondsOf(
	expiresAt: unknown,
	now: number,
): { seconds: number } | { problem: string } {
	if (expiresAt === undefined || expiresAt === null) {
		return {
			problem: 'is missing; it takes a Date, or whole seconds since the epoch',
		};
	}
	if (typeof expiresAt === 'number') {
		if (!Number.isFinite(expiresAt)) {
			return { problem: 'is neither a Date nor a finite number' };
		}
		// Measured on v1.53.2: a fractional `exp` makes every search with the
		// token fail to decode it, and one in milliseconds is accepted, and
		// lasts for millennia.
		if (!Number.isInteger(expiresAt)) {
			return { problem: 'is not a whole number of seconds' };
		}
		if (expiresAt > MAX_SECONDS) {
			return {
				problem: 'is a number of milliseconds; it takes seconds, or a Date',
			};
		}
		return expiresAt * 1000 <= now
			? { problem: 'is in the past' }
			: { seconds: expiresAt };
	}
	let time: number;
	try {
		// Never the caller's own `getTime`: a subclass or an own method can lie.
		time = timeOf.call(expiresAt);
	} catch {
		return { problem: 'is neither a Date nor a finite number' };
	}
	if (Number.isNaN(time)) return { problem: 'is an invalid Date' };
	if (time <= now) return { problem: 'is in the past' };
	const seconds = Math.floor(time / 1000);
	if (seconds > MAX_SECONDS) {
		return {
			problem:
				'is a Date past the year 5138; was it built from milliseconds times 1000?',
		};
	}
	return { seconds };
}

/**
 * The whole seconds to sign for `expiresAt`, or a `SearchIndexError`
 * (`INVALID_EXPIRES_AT`) naming `call`. The message never holds the time.
 */
export function expirySeconds(
	expiresAt: unknown,
	uids: readonly string[],
	call: string,
): number {
	const read = secondsOf(expiresAt, Date.now());
	if ('seconds' in read) return read.seconds;
	throw new SearchIndexError(`${call}: expiresAt ${read.problem}`, {
		code: 'INVALID_EXPIRES_AT',
		indexUid: uids.join(','),
	});
}

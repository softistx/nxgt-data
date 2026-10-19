/** The wall clock of an instant in a zone: what a calendar and a clock there read. */
export interface Wall {
	/** The year. */
	readonly year: number;
	/** The month, 1–12. */
	readonly month: number;
	/** The day of the month, 1–31. */
	readonly day: number;
	/** The hour, 0–23. */
	readonly hour: number;
	/** The minute, 0–59. */
	readonly minute: number;
	/** The second, 0–59. */
	readonly second: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

const DAY_MS = 86_400_000;

function formatOf(zone: string): Intl.DateTimeFormat {
	let format = formats.get(zone);
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		formats.set(zone, format);
	}
	return format;
}

/**
 * Checks that `Intl` knows the time zone `name`.
 *
 * @throws TypeError naming the zone when it does not.
 */
export function checkZone(name: string): void {
	try {
		formatOf(name);
	} catch {
		throw new TypeError(
			`timezone ${JSON.stringify(name)} is not a time zone name Intl accepts, such as "UTC" or "Europe/Paris"`,
		);
	}
}

/** The wall clock in `zone` at the instant `ms`, to the second. */
export function wallOf(ms: number, zone: string): Wall {
	const read = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
	for (const part of formatOf(zone).formatToParts(new Date(ms))) {
		if (part.type in read) {
			read[part.type as keyof typeof read] = Number(part.value);
		}
	}
	return {
		year: read.year,
		month: read.month,
		day: read.day,
		hour: read.hour % 24,
		minute: read.minute,
		second: read.second,
	};
}

/** A wall time read as if it were UTC: the calendar arithmetic of the module. */
function asUtc(wall: Wall): number {
	return Date.UTC(
		wall.year,
		wall.month - 1,
		wall.day,
		wall.hour,
		wall.minute,
		wall.second,
	);
}

/** The zone's offset from UTC at an instant, in ms (wall as UTC minus the instant). */
function offsetAt(ms: number, zone: string): number {
	return asUtc(wallOf(ms, zone)) - Math.floor(ms / 1000) * 1000;
}

/**
 * The first instant at which the zone's clock reads `wall`.
 *
 * - A time that happens twice (the clocks went back) gives the earlier one.
 * - A time that does not exist (the clocks went forward) gives the first
 *   instant after the gap, the transition, with `inGap` set.
 */
export function instantsOf(
	wall: Wall,
	zone: string,
): { first: number; inGap: boolean } {
	const target = asUtc(wall);
	const before = offsetAt(target - DAY_MS, zone);
	const after = offsetAt(target + DAY_MS, zone);
	const valid = [before, after]
		.map((offset) => target - offset)
		.filter((guess) => asUtc(wallOf(guess, zone)) === target);
	if (valid.length > 0) {
		return { first: Math.min(...valid), inGap: false };
	}
	return {
		first: transitionBetween(target - after, target - before, before, zone),
		inGap: true,
	};
}

/** The first instant in `(lo, hi]` whose offset is no longer `offsetAtLo`, by bisection. */
function transitionBetween(
	lo: number,
	hi: number,
	offsetAtLo: number,
	zone: string,
): number {
	let low = lo;
	let high = hi;
	while (high - low > 1000) {
		const mid = low + Math.floor((high - low) / 2000) * 1000;
		if (offsetAt(mid, zone) === offsetAtLo) {
			low = mid;
		} else {
			high = mid;
		}
	}
	return high;
}

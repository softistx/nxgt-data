import { type Cron, matchesDay, matchesTime } from './cron';
import { instantsOf, wallOf } from './zone';

/**
 * How many days the search walks. A cron that passed the reachability check
 * meets a day within the longest gap between two leap days (8 years).
 */
const MAX_DAYS = 3000;

/** Wall times this far before `t`'s wall time cannot have a first instant after `t`. */
const SKIP_BEFORE_MS = 3 * 3_600_000;

/**
 * The first instant after `t` whose wall time in `zone` matches `cron`.
 *
 * A wall time that does not exist (the clocks went forward) runs at the first
 * instant after the gap. One that happens twice (the clocks went back) runs
 * once, at its first instant: in the second pass, a wall time whose first
 * instant is not after `t` is skipped.
 *
 * @throws Error when no match is found within the search bound, which a cron
 * accepted by `parseCron` never reaches.
 */
export function nextAfter(cron: Cron, zone: string, t: number): number {
	const start = wallOf(t, zone);
	const startUtc = Date.UTC(
		start.year,
		start.month - 1,
		start.day,
		start.hour,
		start.minute,
		start.second,
	);
	for (let i = 0; i < MAX_DAYS; i++) {
		const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!matchesDay(cron, month, day, date.getUTCDay())) {
			continue;
		}
		for (let hour = 0; hour < 24; hour++) {
			for (let minute = 0; minute < 60; minute++) {
				if (!matchesTime(cron, hour, minute)) {
					continue;
				}
				if (
					Date.UTC(year, month - 1, day, hour, minute) <
					startUtc - SKIP_BEFORE_MS
				) {
					continue;
				}
				const { first } = instantsOf(
					{ year, month, day, hour, minute, second: 0 },
					zone,
				);
				if (first > t) {
					return first;
				}
			}
		}
	}
	throw new Error(
		`no occurrence within ${MAX_DAYS} days of ${new Date(t).toISOString()} in ${zone}; this is a bug`,
	);
}

/**
 * The next occurrence of an `every` schedule: the first `due + k × everyMs`
 * greater than `now`, for whole `k ≥ 1`. An outage skips the missed ticks and
 * the grid keeps its phase.
 */
export function nextEvery(due: number, everyMs: number, now: number): number {
	const k = Math.max(1, Math.floor((now - due) / everyMs) + 1);
	return due + k * everyMs;
}

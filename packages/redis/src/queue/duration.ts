/**
 * A span of time: a whole number of milliseconds, or a string with a unit —
 * `'250ms'`, `'30s'`, `'10m'`, `'2h'`, `'7d'`. A fraction is fine in a string
 * (`'1.5s'`) as long as the result is a whole number of milliseconds.
 */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/**
 * Milliseconds of a {@link Duration}. `what` names the option being read, so
 * the refusal says which one was wrong.
 *
 * @throws TypeError for a negative, fractional, non-finite or malformed value.
 */
export function toMs(value: Duration, what: string): number {
	const ms = parse(value);
	if (ms === undefined || !Number.isSafeInteger(ms)) {
		throw new TypeError(
			`${what} is ${JSON.stringify(value)}; a duration is a whole number of milliseconds or a string such as '10m'`,
		);
	}
	return ms;
}

function parse(value: Duration): number | undefined {
	if (typeof value === 'number') {
		return value >= 0 ? value : undefined;
	}
	const match = typeof value === 'string' ? PATTERN.exec(value) : null;
	if (!match) {
		return undefined;
	}
	// Rounding absorbs float noise ('1.1s' is 1100.0000000000002), so only a
	// real fraction of a millisecond is refused.
	const exact = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
	const rounded = Math.round(exact);
	return Math.abs(exact - rounded) < 1e-6 ? rounded : undefined;
}

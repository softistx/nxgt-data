/**
 * A parsed five-field cron: the values each field allows, and whether the day
 * of month and the day of week were written as something other than `*`.
 */
export interface Cron {
	/** Allowed minutes, 0–59. */
	readonly minutes: ReadonlySet<number>;
	/** Allowed hours, 0–23. */
	readonly hours: ReadonlySet<number>;
	/** Allowed days of the month, 1–31. */
	readonly days: ReadonlySet<number>;
	/** Allowed months, 1–12. */
	readonly months: ReadonlySet<number>;
	/** Allowed days of the week, 0–6 where 0 is Sunday (7 is folded into 0). */
	readonly weekdays: ReadonlySet<number>;
	/** The day-of-month field is not exactly `*`. */
	readonly daysRestricted: boolean;
	/** The day-of-week field is not exactly `*`. */
	readonly weekdaysRestricted: boolean;
}

interface Field {
	readonly name: string;
	readonly min: number;
	readonly max: number;
	readonly names?: readonly string[];
	/** The first value `names[0]` stands for. */
	readonly nameBase?: number;
}

const MONTHS = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec',
];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS: readonly Field[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
	{ name: 'day of week', min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

/** The most days each month can have, February counting its leap day. */
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Parses a five-field cron: minute, hour, day of month, month (`1`–`12` or
 * `jan`–`dec`) and day of week (`0`–`7` or `sun`–`sat`, 0 and 7 both Sunday).
 * Each field takes `*`, `a`, `a-b`, `*` with a step (`star/n`), `a-b/n`, `a/n` (`a` to the maximum)
 * and comma lists of those. No macros, no seconds, no `L`, `W` or `#`.
 *
 * @throws TypeError naming the field and the reason, for a malformed cron or
 * one that can never match (`0 0 31 2 *`).
 */
export function parseCron(text: string): Cron {
	const parts = text.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new TypeError(
			`cron needs five fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
		);
	}
	const sets = FIELDS.map((field, i) => parseField(parts[i] as string, field));
	const [minutes, hours, days, months, weekdays] = sets as [
		Set<number>,
		Set<number>,
		Set<number>,
		Set<number>,
		Set<number>,
	];
	weekdays.delete(7) && weekdays.add(0);
	const cron: Cron = {
		minutes,
		hours,
		days,
		months,
		weekdays,
		daysRestricted: parts[2] !== '*',
		weekdaysRestricted: parts[4] !== '*',
	};
	checkReachable(cron);
	return cron;
}

/**
 * Whether a day matches: its month must be listed, and then, as in Vixie
 * cron, the day of month or the day of week when both are restricted, the one
 * that is restricted when only one is, and any day when neither is.
 *
 * @param month 1–12.
 * @param dayOfMonth 1–31.
 * @param dayOfWeek 0–6, 0 being Sunday.
 */
export function matchesDay(
	cron: Cron,
	month: number,
	dayOfMonth: number,
	dayOfWeek: number,
): boolean {
	if (!cron.months.has(month)) {
		return false;
	}
	const day = cron.days.has(dayOfMonth);
	const week = cron.weekdays.has(dayOfWeek);
	return cron.daysRestricted && cron.weekdaysRestricted
		? day || week
		: day && week;
}

/** Whether the hour and the minute are both listed. */
export function matchesTime(cron: Cron, hour: number, minute: number): boolean {
	return cron.hours.has(hour) && cron.minutes.has(minute);
}

function parseField(text: string, field: Field): Set<number> {
	const values = new Set<number>();
	for (const item of text.split(',')) {
		const [range, step, extra] = item.split('/');
		if (extra !== undefined || range === undefined) {
			throw refusal(field, `"${item}" has more than one "/"`);
		}
		const stride = step === undefined ? 1 : number(step, field, 'a step');
		if (stride < 1) {
			throw refusal(field, `step ${stride} must be at least 1`);
		}
		const [from, to] = bounds(range, step !== undefined, field);
		for (let v = from; v <= to; v += stride) {
			values.add(v);
		}
	}
	return values;
}

function bounds(
	range: string,
	stepped: boolean,
	field: Field,
): [number, number] {
	if (range === '*') {
		// A star never reaches 7, so Sunday is not listed twice.
		return [field.min, field.max === 7 ? 6 : field.max];
	}
	const [a, b, extra] = range.split('-');
	if (extra !== undefined || a === undefined) {
		throw refusal(field, `"${range}" is not a value or a range`);
	}
	const from = value(a, field);
	if (b === undefined) {
		return [from, stepped ? field.max : from];
	}
	const to = value(b, field);
	if (from > to) {
		throw refusal(field, `range ${range} is reversed`);
	}
	return [from, to];
}

function value(text: string, field: Field): number {
	const index = field.names?.indexOf(text.toLowerCase()) ?? -1;
	const v =
		index >= 0
			? index + (field.nameBase as number)
			: number(text, field, 'a value');
	if (v < field.min || v > field.max) {
		throw refusal(field, `${v} is out of range ${field.min}-${field.max}`);
	}
	return v;
}

function number(text: string, field: Field, what: string): number {
	if (!/^\d+$/.test(text)) {
		throw refusal(
			field,
			`"${text}" is not ${what}${field.names ? ' or a name' : ''}`,
		);
	}
	return Number(text);
}

function refusal(field: Field, reason: string): TypeError {
	return new TypeError(`cron ${field.name}: ${reason}`);
}

/**
 * Refuses a cron whose days can never exist: only a restricted day of month
 * with a day of week of `*` can fail to match, and it fails when no listed
 * month has any listed day.
 */
function checkReachable(cron: Cron): void {
	if (!cron.daysRestricted || cron.weekdaysRestricted) {
		return;
	}
	for (const month of cron.months) {
		for (const day of cron.days) {
			if (day <= (LONGEST_MONTH[month - 1] as number)) {
				return;
			}
		}
	}
	throw new TypeError(
		'cron day of month: no listed month has any listed day, so it would never match',
	);
}

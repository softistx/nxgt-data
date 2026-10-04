/** The calendar rules, finest first. */
export const CALENDAR = [
	'hourly',
	'daily',
	'weekly',
	'monthly',
	'yearly',
] as const;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The ISO week of `date`, in UTC: `2026-W40`. */
function isoWeek(date: Date): string {
	const day = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${pad(week)}`;
}

/** The period `date` falls in for `rule`, in UTC: `2026-10-03`, `2026-W40`. */
export function periodOf(rule: (typeof CALENDAR)[number], date: Date): string {
	const y = date.getUTCFullYear();
	const m = pad(date.getUTCMonth() + 1);
	const d = pad(date.getUTCDate());
	switch (rule) {
		case 'hourly':
			return `${y}-${m}-${d}T${pad(date.getUTCHours())}`;
		case 'daily':
			return `${y}-${m}-${d}`;
		case 'weekly':
			return isoWeek(date);
		case 'monthly':
			return `${y}-${m}`;
		case 'yearly':
			return `${y}`;
	}
}

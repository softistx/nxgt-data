import { expect, test } from 'bun:test';
import { matchesDay, matchesTime, parseCron } from './cron';

const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

test('a star takes the whole range, and a field beginning with a star is a star', () => {
	const cron = parseCron('* * * * *');
	expect(cron.minutes.size).toBe(60);
	expect(cron.hours.size).toBe(24);
	expect(cron.days.size).toBe(31);
	expect(cron.months.size).toBe(12);
	expect(sorted(cron.weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	expect(cron.daysStar).toBe(true);
	expect(cron.weekdaysStar).toBe(true);
	const some = parseCron('0 0 1 * 1');
	expect(some.daysStar).toBe(false);
	expect(some.weekdaysStar).toBe(false);
	const stepped = parseCron('0 0 */2 * */3');
	expect(stepped.daysStar).toBe(true);
	expect(stepped.weekdaysStar).toBe(true);
});

test.each([
	['5 * * * *', 'minutes', [5]],
	['10-13 * * * *', 'minutes', [10, 11, 12, 13]],
	['*/20 * * * *', 'minutes', [0, 20, 40]],
	['10-30/10 * * * *', 'minutes', [10, 20, 30]],
	['50/5 * * * *', 'minutes', [50, 55]],
	['1,5-6,*/30 * * * *', 'minutes', [0, 1, 5, 6, 30]],
	['0 */8 * * *', 'hours', [0, 8, 16]],
	['0 0 */10 * *', 'days', [1, 11, 21, 31]],
	['0 0 * 2-4 *', 'months', [2, 3, 4]],
	['0 0 * */6 *', 'months', [1, 7]],
	['0 0 * * 1-5', 'weekdays', [1, 2, 3, 4, 5]],
	['0 0 * * 1/2', 'weekdays', [1, 3, 5]],
	['0 0 * * 5/1', 'weekdays', [5, 6]],
	['0 0 * * 5-7/1', 'weekdays', [0, 5, 6]],
] as const)('%s reads %s as %p', (text, field, values) => {
	expect(sorted(parseCron(text)[field])).toEqual([...values]);
});

test('names are case-insensitive, and 7 is Sunday like 0', () => {
	expect(sorted(parseCron('0 0 * JAN,Feb,dec *').months)).toEqual([1, 2, 12]);
	expect(sorted(parseCron('0 0 * * Mon-FRI').weekdays)).toEqual([
		1, 2, 3, 4, 5,
	]);
	expect(sorted(parseCron('0 0 * * sun').weekdays)).toEqual([0]);
	expect(sorted(parseCron('0 0 * * 7').weekdays)).toEqual([0]);
	expect(sorted(parseCron('0 0 * * 5-7').weekdays)).toEqual([0, 5, 6]);
	expect(sorted(parseCron('0 0 * mar-may *').months)).toEqual([3, 4, 5]);
});

test('extra spaces between fields are fine', () => {
	expect(sorted(parseCron('  0   12 * * *  ').hours)).toEqual([12]);
});

test.each([
	['60 * * * *', 'minute'],
	['* 24 * * *', 'hour'],
	['* * 0 * *', 'day of month'],
	['* * 32 * *', 'day of month'],
	['* * * 13 *', 'month'],
	['* * * 0 *', 'month'],
	['* * * * 8', 'day of week'],
	['*/0 * * * *', 'minute'],
	['* 5-1 * * *', 'hour'],
	['* * * foo *', 'month'],
	['* * * * mondy', 'day of week'],
	['* * * * *  *', 'five fields'],
	['* * * *', 'five fields'],
	['', 'five fields'],
	['@daily', 'five fields'],
	['@daily * * * *', 'minute'],
	['*/-1 * * * *', 'minute'],
	['1,,2 * * * *', 'minute'],
	['1.5 * * * *', 'minute'],
	['L * * * *', 'minute'],
	['* * 15W * *', 'day of month'],
	['* * * * 1#2', 'day of week'],
])('%p is refused, naming %s', (text, name) => {
	expect(() => parseCron(text)).toThrow(TypeError);
	expect(() => parseCron(text)).toThrow(name);
});

test.each(['0 0 31 2 *', '0 0 30 2 *', '0 0 31 4,6,9,11 *', '0 0 30-31 feb *'])(
	'%s can never match and is refused',
	(text) => {
		expect(() => parseCron(text)).toThrow(TypeError);
		expect(() => parseCron(text)).toThrow('never');
	},
);

test('a leap day, and a date some listed month has, are accepted', () => {
	expect(() => parseCron('0 0 29 2 *')).not.toThrow();
	expect(() => parseCron('0 0 31 2,3 *')).not.toThrow();
	// With a day of week listed too, the OR rule makes the date reachable.
	expect(() => parseCron('0 0 31 2 1')).not.toThrow();
	// AND with a weekday step: Feb 29 on a Sunday, Wednesday or Saturday.
	expect(() => parseCron('0 0 29 2 */3')).not.toThrow();
	// Feb 29 on a Sunday comes every 28 years or so: far past a few thousand days.
	expect(() => parseCron('0 0 29 2 */7')).not.toThrow();
});

test('an impossible cron is found by an exact walk, quickly', () => {
	const started = performance.now();
	expect(() => parseCron('0 0 31 2 *')).toThrow('never');
	expect(() => parseCron('0 0 30 2 *')).toThrow('never');
	// Feb 30th in AND with a weekday step is impossible too.
	expect(() => parseCron('0 0 30 2 */3')).toThrow('never');
	expect(performance.now() - started).toBeLessThan(1500);
});

test('Vixie OR: restricted day of month and day of week match either', () => {
	const cron = parseCron('0 0 13 * 5');
	// 2026-02-13 is a Friday and the 13th; 2026-03-13 is a Friday; 2026-06-13 a Saturday.
	expect(matchesDay(cron, 6, 13, 6)).toBe(true);
	expect(matchesDay(cron, 6, 12, 5)).toBe(true);
	expect(matchesDay(cron, 6, 12, 6)).toBe(false);
	expect(matchesDay(cron, 6, 14, 0)).toBe(false);
});

test('a star with a step makes the day rule an AND, as in Vixie cron', () => {
	// */2 in day of month: odd days that are Mondays.
	const cron = parseCron('0 0 */2 * 1');
	expect(matchesDay(cron, 5, 11, 1)).toBe(true);
	expect(matchesDay(cron, 5, 12, 1)).toBe(false);
	expect(matchesDay(cron, 5, 11, 2)).toBe(false);
	// */1 in day of month leaves the day of week alone to decide.
	const every = parseCron('0 0 */1 * 1');
	expect(matchesDay(every, 5, 12, 1)).toBe(true);
	expect(matchesDay(every, 5, 12, 2)).toBe(false);
	// A star-stepped weekday ANDs with the day of month.
	const week = parseCron('0 0 13 * */2');
	expect(matchesDay(week, 6, 13, 0)).toBe(true);
	expect(matchesDay(week, 6, 13, 1)).toBe(false);
	expect(matchesDay(week, 6, 14, 0)).toBe(false);
});

test('with one of them a star, the other alone decides, and month filters', () => {
	const onlyDays = parseCron('0 0 15 * *');
	expect(matchesDay(onlyDays, 5, 15, 3)).toBe(true);
	expect(matchesDay(onlyDays, 5, 16, 15)).toBe(false);
	const onlyWeek = parseCron('0 0 * * 1');
	expect(matchesDay(onlyWeek, 5, 20, 1)).toBe(true);
	expect(matchesDay(onlyWeek, 5, 1, 2)).toBe(false);
	const march = parseCron('0 0 * 3 *');
	expect(matchesDay(march, 3, 9, 1)).toBe(true);
	expect(matchesDay(march, 4, 9, 1)).toBe(false);
	// The month still applies to an OR of day and weekday.
	const both = parseCron('0 0 13 3 5');
	expect(matchesDay(both, 4, 13, 5)).toBe(false);
});

test('matchesTime reads the hour and the minute', () => {
	const cron = parseCron('30 2,14 * * *');
	expect(matchesTime(cron, 2, 30)).toBe(true);
	expect(matchesTime(cron, 14, 30)).toBe(true);
	expect(matchesTime(cron, 2, 31)).toBe(false);
	expect(matchesTime(cron, 3, 30)).toBe(false);
});

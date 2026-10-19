import { expect, test } from 'bun:test';
import { parseCron } from './cron';
import { nextAfter, nextEvery } from './next';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) =>
	Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms: number) => new Date(ms).toISOString();
const next = (text: string, zone: string, t: number) =>
	nextAfter(parseCron(text), zone, t);

test('minutes, hours and months roll over', () => {
	expect(iso(next('* * * * *', 'UTC', utc(2026, 1, 1, 0, 0) + 1))).toBe(
		'2026-01-01T00:01:00.000Z',
	);
	expect(iso(next('*/15 * * * *', 'UTC', utc(2026, 1, 1, 10, 50)))).toBe(
		'2026-01-01T11:00:00.000Z',
	);
	expect(iso(next('0 0 * * *', 'UTC', utc(2026, 1, 1, 23, 59)))).toBe(
		'2026-01-02T00:00:00.000Z',
	);
	expect(iso(next('0 0 * * *', 'UTC', utc(2026, 12, 31, 12, 0)))).toBe(
		'2027-01-01T00:00:00.000Z',
	);
	expect(iso(next('0 9 31 * *', 'UTC', utc(2026, 4, 1)))).toBe(
		'2026-05-31T09:00:00.000Z',
	);
	expect(iso(next('0 0 1 * *', 'UTC', utc(2026, 1, 31, 12)))).toBe(
		'2026-02-01T00:00:00.000Z',
	);
});

test('t exactly on a match gives the next one, and a second after is still the next', () => {
	const on = utc(2026, 5, 5, 12, 30);
	expect(iso(next('30 12 * * *', 'UTC', on))).toBe('2026-05-06T12:30:00.000Z');
	expect(iso(next('30 12 * * *', 'UTC', on - 1))).toBe(
		'2026-05-05T12:30:00.000Z',
	);
	expect(iso(next('* * * * *', 'UTC', on + 999))).toBe(
		'2026-05-05T12:31:00.000Z',
	);
});

test('a leap day is found years ahead', () => {
	expect(iso(next('0 0 29 2 *', 'UTC', utc(2026, 3, 1)))).toBe(
		'2028-02-29T00:00:00.000Z',
	);
	expect(iso(next('0 0 29 2 *', 'UTC', utc(2096, 3, 1)))).toBe(
		'2104-02-29T00:00:00.000Z',
	);
});

test('day of week, and the Vixie OR', () => {
	// 2026-05-05 is a Tuesday.
	expect(iso(next('0 8 * * mon', 'UTC', utc(2026, 5, 5)))).toBe(
		'2026-05-11T08:00:00.000Z',
	);
	expect(iso(next('0 8 * * 0', 'UTC', utc(2026, 5, 5)))).toBe(
		'2026-05-10T08:00:00.000Z',
	);
	expect(iso(next('0 8 * * 7', 'UTC', utc(2026, 5, 5)))).toBe(
		'2026-05-10T08:00:00.000Z',
	);
	// 13th or Friday: 2026-05-08 is the Friday before the 13th.
	expect(iso(next('0 0 13 * 5', 'UTC', utc(2026, 5, 5)))).toBe(
		'2026-05-08T00:00:00.000Z',
	);
	expect(iso(next('0 0 13 * 5', 'UTC', utc(2026, 5, 8, 0, 0)))).toBe(
		'2026-05-13T00:00:00.000Z',
	);
});

test('Europe/Paris spring forward: 02:30 does not exist and runs at 03:00 local', () => {
	const got = next('30 2 * * *', 'Europe/Paris', utc(2026, 3, 28, 12));
	expect(iso(got)).toBe('2026-03-29T01:00:00.000Z');
	// Once only: the day after runs at its own 02:30 local (00:30Z).
	expect(iso(next('30 2 * * *', 'Europe/Paris', got))).toBe(
		'2026-03-30T00:30:00.000Z',
	);
});

test('two gap times of one cron run once at the transition', () => {
	const cron = parseCron('15,45 2 * * *');
	const first = nextAfter(cron, 'Europe/Paris', utc(2026, 3, 28, 12));
	expect(iso(first)).toBe('2026-03-29T01:00:00.000Z');
	expect(iso(nextAfter(cron, 'Europe/Paris', first))).toBe(
		'2026-03-30T00:15:00.000Z',
	);
});

test('Europe/Paris fall back: 02:30 runs once, at 00:30Z, not again at 01:30Z', () => {
	const got = next('30 2 * * *', 'Europe/Paris', utc(2026, 10, 24, 12));
	expect(iso(got)).toBe('2026-10-25T00:30:00.000Z');
	// From the second pass, the next is the day after (02:30 CET is 01:30Z).
	expect(iso(next('30 2 * * *', 'Europe/Paris', utc(2026, 10, 25, 1, 0)))).toBe(
		'2026-10-26T01:30:00.000Z',
	);
	expect(iso(next('30 2 * * *', 'Europe/Paris', got))).toBe(
		'2026-10-26T01:30:00.000Z',
	);
});

test('America/New_York gap and fold', () => {
	expect(iso(next('30 2 * * *', 'America/New_York', utc(2026, 3, 7, 12)))).toBe(
		'2026-03-08T07:00:00.000Z',
	);
	expect(
		iso(next('30 1 * * *', 'America/New_York', utc(2026, 10, 31, 12))),
	).toBe('2026-11-01T05:30:00.000Z');
	expect(
		iso(next('30 1 * * *', 'America/New_York', utc(2026, 11, 1, 5, 30))),
	).toBe('2026-11-02T06:30:00.000Z');
});

test('fall back with */15 1 * * *: each quarter runs once, in the first pass only', () => {
	const cron = parseCron('*/15 1 * * *');
	const seen: string[] = [];
	let t = utc(2026, 11, 1, 3, 0);
	for (let i = 0; i < 6; i++) {
		t = nextAfter(cron, 'America/New_York', t);
		seen.push(iso(t));
	}
	expect(seen).toEqual([
		'2026-11-01T05:00:00.000Z',
		'2026-11-01T05:15:00.000Z',
		'2026-11-01T05:30:00.000Z',
		'2026-11-01T05:45:00.000Z',
		'2026-11-02T06:00:00.000Z',
		'2026-11-02T06:15:00.000Z',
	]);
	// Asked from inside the second pass (06:20Z is 01:20 EST), none of them returns.
	expect(
		iso(nextAfter(cron, 'America/New_York', utc(2026, 11, 1, 6, 20))),
	).toBe('2026-11-02T06:00:00.000Z');
});

test('Australia/Lord_Howe, whose shift is 30 minutes, follows the same rules', () => {
	// Spring forward 2026-10-04: 02:00 to 02:30; 02:15 runs at 02:30 local (15:30Z the day before).
	expect(
		iso(next('15 2 * * *', 'Australia/Lord_Howe', utc(2026, 10, 3, 0))),
	).toBe('2026-10-03T15:30:00.000Z');
	// Fall back 2026-04-05: 02:00 to 01:30; 01:45 runs once, in the first pass (14:45Z the day before).
	const got = next('45 1 * * *', 'Australia/Lord_Howe', utc(2026, 4, 4, 0));
	expect(iso(got)).toBe('2026-04-04T14:45:00.000Z');
	expect(iso(next('45 1 * * *', 'Australia/Lord_Howe', got))).toBe(
		'2026-04-05T15:15:00.000Z',
	);
});

test('a zone with no DST keeps its offset all year', () => {
	expect(iso(next('0 9 * * *', 'Asia/Tokyo', utc(2026, 3, 7, 23)))).toBe(
		'2026-03-08T00:00:00.000Z',
	);
	expect(iso(next('0 9 * * *', 'Asia/Tokyo', utc(2026, 3, 8, 0, 0)))).toBe(
		'2026-03-09T00:00:00.000Z',
	);
	expect(iso(next('30 23 * * *', 'Asia/Tokyo', utc(2026, 11, 1)))).toBe(
		'2026-11-01T14:30:00.000Z',
	);
});

test('the wall date is the zone date: 19:00 in Tokyo is already the evening of its own day', () => {
	expect(iso(next('0 1 * * *', 'Asia/Tokyo', utc(2026, 6, 1, 10, 0)))).toBe(
		'2026-06-01T16:00:00.000Z',
	);
});

test('the machine time zone does not matter', () => {
	const before = process.env.TZ;
	const results: string[] = [];
	try {
		for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
			process.env.TZ = tz;
			results.push(
				iso(next('30 2 * * *', 'Europe/Paris', utc(2026, 3, 28, 12))),
				iso(next('*/15 1 * * *', 'America/New_York', utc(2026, 11, 1, 5, 20))),
				iso(next('0 0 29 2 *', 'Asia/Tokyo', utc(2026, 3, 1))),
			);
		}
	} finally {
		if (before === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = before;
		}
	}
	const expected = [
		'2026-03-29T01:00:00.000Z',
		'2026-11-01T05:30:00.000Z',
		'2028-02-28T15:00:00.000Z',
	];
	expect(results).toEqual([...expected, ...expected, ...expected]);
});

test('nextEvery stays on the grid', () => {
	expect(nextEvery(1000, 500, 1200)).toBe(1500);
	expect(nextEvery(1000, 500, 1000)).toBe(1500);
	expect(nextEvery(1000, 500, 1499)).toBe(1500);
	expect(nextEvery(1000, 500, 1500)).toBe(2000);
});

test('nextEvery after an outage of 3 ticks fires once and keeps the phase', () => {
	expect(nextEvery(1000, 500, 1000 + 3 * 500 + 120)).toBe(1000 + 4 * 500);
	expect(nextEvery(1000, 500, 1000 + 3 * 500)).toBe(1000 + 4 * 500);
	// A clock behind the occurrence still moves forward by one tick.
	expect(nextEvery(1000, 500, 100)).toBe(1500);
});

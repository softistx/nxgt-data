import { expect, test } from 'bun:test';
import { checkZone, instantsOf, wallOf } from './zone';

const wall = (
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
) => ({
	year,
	month,
	day,
	hour,
	minute,
	second: 0,
});

test('checkZone accepts IANA names and refuses the rest with the name', () => {
	expect(() => checkZone('UTC')).not.toThrow();
	expect(() => checkZone('Europe/Paris')).not.toThrow();
	expect(() => checkZone('Mars/Olympus')).toThrow(TypeError);
	expect(() => checkZone('Mars/Olympus')).toThrow('Mars/Olympus');
	expect(() => checkZone('')).toThrow(TypeError);
});

test('wallOf reads the wall clock of an instant in a zone', () => {
	const ms = Date.UTC(2026, 0, 15, 23, 30, 45);
	expect(wallOf(ms, 'UTC')).toEqual({
		year: 2026,
		month: 1,
		day: 15,
		hour: 23,
		minute: 30,
		second: 45,
	});
	expect(wallOf(ms, 'Asia/Tokyo')).toEqual({
		year: 2026,
		month: 1,
		day: 16,
		hour: 8,
		minute: 30,
		second: 45,
	});
	expect(wallOf(ms, 'America/New_York')).toEqual({
		year: 2026,
		month: 1,
		day: 15,
		hour: 18,
		minute: 30,
		second: 45,
	});
	// Midnight reads as hour 0, never 24.
	expect(wallOf(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC').hour).toBe(0);
});

test('a wall time that exists maps to its instant', () => {
	expect(instantsOf(wall(2026, 7, 1, 12, 0), 'Europe/Paris')).toEqual({
		first: Date.UTC(2026, 6, 1, 10, 0),
		inGap: false,
	});
	expect(instantsOf(wall(2026, 7, 1, 12, 0), 'Asia/Tokyo')).toEqual({
		first: Date.UTC(2026, 6, 1, 3, 0),
		inGap: false,
	});
	expect(instantsOf(wall(2026, 1, 1, 0, 0), 'UTC').first).toBe(
		Date.UTC(2026, 0, 1),
	);
});

test('a wall time in the spring gap maps to the instant just after it', () => {
	// Paris, 2026-03-29: 02:00 CET jumps to 03:00 CEST, at 01:00Z.
	expect(instantsOf(wall(2026, 3, 29, 2, 30), 'Europe/Paris')).toEqual({
		first: Date.UTC(2026, 2, 29, 1, 0),
		inGap: true,
	});
	expect(instantsOf(wall(2026, 3, 29, 2, 0), 'Europe/Paris').inGap).toBe(true);
	expect(instantsOf(wall(2026, 3, 29, 3, 0), 'Europe/Paris')).toEqual({
		first: Date.UTC(2026, 2, 29, 1, 0),
		inGap: false,
	});
	expect(instantsOf(wall(2026, 3, 29, 1, 59), 'Europe/Paris').first).toBe(
		Date.UTC(2026, 2, 29, 0, 59),
	);
	// New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT, at 07:00Z.
	expect(instantsOf(wall(2026, 3, 8, 2, 15), 'America/New_York')).toEqual({
		first: Date.UTC(2026, 2, 8, 7, 0),
		inGap: true,
	});
	// Lord Howe, 2026-10-04: 02:00 jumps to 02:30 (+10:30 to +11), at 15:30Z the day before.
	expect(instantsOf(wall(2026, 10, 4, 2, 15), 'Australia/Lord_Howe')).toEqual({
		first: Date.UTC(2026, 9, 3, 15, 30),
		inGap: true,
	});
});

test('a wall time in the fall fold maps to its first instant', () => {
	// Paris, 2026-10-25: 03:00 CEST falls back to 02:00 CET, at 01:00Z.
	expect(instantsOf(wall(2026, 10, 25, 2, 30), 'Europe/Paris')).toEqual({
		first: Date.UTC(2026, 9, 25, 0, 30),
		inGap: false,
	});
	// New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST, at 06:00Z.
	expect(instantsOf(wall(2026, 11, 1, 1, 30), 'America/New_York').first).toBe(
		Date.UTC(2026, 10, 1, 5, 30),
	);
	// Lord Howe, 2026-04-05: 02:00 (+11) falls back to 01:30 (+10:30), at 15:00Z the day before.
	expect(instantsOf(wall(2026, 4, 5, 1, 45), 'Australia/Lord_Howe').first).toBe(
		Date.UTC(2026, 3, 4, 14, 45),
	);
});

test('the day after a transition is back to a plain mapping', () => {
	expect(instantsOf(wall(2026, 3, 30, 2, 30), 'Europe/Paris')).toEqual({
		first: Date.UTC(2026, 2, 30, 0, 30),
		inGap: false,
	});
});

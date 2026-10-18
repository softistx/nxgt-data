import { expect, test } from 'bun:test';
import { durationMs, toMs } from './duration';

test('a number is milliseconds, a string has a unit', () => {
	expect(toMs(250, 'delay')).toBe(250);
	expect(toMs('1.5s', 'delay')).toBe(1500);
	expect(toMs('10m', 'delay')).toBe(600_000);
	expect(toMs('2h', 'delay')).toBe(7_200_000);
	expect(toMs('7d', 'keepFailed')).toBe(604_800_000);
});

test.each([
	-1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	'10min',
	'',
	'm',
	'-5s',
	'1.5ms',
])('%p is refused, naming the option', (v) => {
	expect(() => toMs(v as never, 'delay')).toThrow(
		/^delay is .*; a duration is a whole number of milliseconds/,
	);
});

test('a refusal is a TypeError', () => {
	expect(() => toMs(-1, 'delay')).toThrow(TypeError);
});

test('durationMs answers undefined, never a message with the value', () => {
	expect(durationMs('10m')).toBe(600_000);
	expect(durationMs(-1)).toBeUndefined();
	expect(durationMs('10min')).toBeUndefined();
	expect(durationMs(undefined)).toBeUndefined();
});

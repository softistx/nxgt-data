import { describe, expect, test } from 'bun:test';
import { clampTimeout, MAX_TIMER_MS } from './timers';

describe('clampTimeout', () => {
	test('a wait above the timer cap runs as the cap; below it, as is', () => {
		expect(MAX_TIMER_MS).toBe(2_147_483_647);
		expect(clampTimeout(2_147_483_648)).toBe(2_147_483_647);
		expect(clampTimeout(30 * 86_400_000)).toBe(2_147_483_647);
		expect(clampTimeout(1_000)).toBe(1_000);
		expect(clampTimeout(undefined)).toBeUndefined();
	});

	test('a negative wait is floored at 0', () => {
		expect(clampTimeout(-5)).toBe(0);
		expect(clampTimeout(Number.NEGATIVE_INFINITY)).toBe(0);
	});
});

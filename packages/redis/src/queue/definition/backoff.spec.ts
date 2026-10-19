import { describe, expect, test } from 'bun:test';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
	test('doubles up to max, with full jitter', () => {
		const backoff = { base: 10, max: 50 };
		const top = () => 0.999;
		const delays = Array.from({ length: 10 }, (_, i) =>
			backoffDelay(i + 1, backoff, top),
		);
		expect(delays).toEqual([9, 19, 39, 49, 49, 49, 49, 49, 49, 49]);
		expect(backoffDelay(3, backoff, () => 0)).toBe(0);
	});

	test('stays below the cap for any random', () => {
		for (let i = 0; i < 100; i += 1) {
			const delay = backoffDelay(30, { base: 1000, max: 5000 });
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThan(5000);
		}
	});
});

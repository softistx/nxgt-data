import { describe, expect, test } from 'bun:test';
import { cropFromQuery } from './from-query';

describe('cropFromQuery', () => {
	test('is undefined when none of x, y and size is present', () => {
		expect(cropFromQuery(new URLSearchParams())).toBeUndefined();
		expect(cropFromQuery(new URLSearchParams('other=1'))).toBeUndefined();
	});

	test('reads the three numbers', () => {
		expect(cropFromQuery(new URLSearchParams('x=1&y=2&size=30'))).toEqual({
			x: 1,
			y: 2,
			size: 30,
		});
	});

	test('a missing, blank or non-numeric value is NaN, so the store refuses it', () => {
		const crop = cropFromQuery(new URLSearchParams('x=&y=abc'));
		expect(crop).toEqual({
			x: Number.NaN,
			y: Number.NaN,
			size: Number.NaN,
		});
		const spaces = cropFromQuery(new URLSearchParams('x=%20&y=1&size=2'));
		expect(spaces?.x).toBeNaN();
		expect(spaces?.y).toBe(1);
	});

	test('one present parameter is already a crop', () => {
		const crop = cropFromQuery(new URLSearchParams('size=5'));
		expect(crop?.size).toBe(5);
		expect(crop?.x).toBeNaN();
	});
});

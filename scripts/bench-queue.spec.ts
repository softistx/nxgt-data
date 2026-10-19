import { describe, expect, test } from 'bun:test';
import { percentile, perSecond, renderTable } from './bench-queue-format';

describe('percentile', () => {
	const samples = Array.from({ length: 100 }, (_, i) => 100 - i);

	test('p50 and p99 of an unsorted array, nearest rank', () => {
		expect(percentile(samples, 0.5)).toBe(50);
		expect(percentile(samples, 0.99)).toBe(99);
	});

	test('does not reorder its input', () => {
		percentile(samples, 0.5);
		expect(samples[0]).toBe(100);
	});

	test('one sample is every percentile, none is NaN', () => {
		expect(percentile([7], 0.99)).toBe(7);
		expect(percentile([], 0.5)).toBeNaN();
	});
});

describe('perSecond', () => {
	test('rounds a rate to a whole number', () => {
		expect(perSecond(1000, 500)).toBe(2000);
		expect(perSecond(10, 3000)).toBe(3);
	});
});

describe('renderTable', () => {
	test('a Markdown table with a header rule', () => {
		expect(renderTable(['a', 'b'], [['1', '22']])).toBe(
			['| a | b |', '| --- | --- |', '| 1 | 22 |'].join('\n'),
		);
	});
});

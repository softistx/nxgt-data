import { describe, expect, test } from 'bun:test';
import { defineImageSet } from './define-image-set';
import { resolveOptions } from './options';

describe('image set options', () => {
	test('the defaults', () => {
		expect(resolveOptions()).toEqual({
			sizes: [256, 64],
			maxBytes: 5 * 1024 * 1024,
			maxPixels: 25_000_000,
			minSide: 256,
			quality: 80,
			concurrency: 2,
		});
	});

	test('minSide follows the largest size, and can be set', () => {
		expect(resolveOptions({ sizes: [32, 128, 64] }).minSide).toBe(128);
		expect(resolveOptions({ sizes: [32], minSide: 10 }).minSide).toBe(10);
	});

	test('a given option is kept', () => {
		expect(
			resolveOptions({
				sizes: [4096, 1],
				maxBytes: 1,
				maxPixels: 7,
				quality: 100,
				concurrency: 64,
			}),
		).toEqual({
			sizes: [4096, 1],
			maxBytes: 1,
			maxPixels: 7,
			minSide: 4096,
			quality: 100,
			concurrency: 64,
		});
	});

	const invalid: [string, Parameters<typeof defineImageSet>[0], RegExp][] = [
		['empty sizes', { sizes: [] }, /sizes/],
		['sizes not an array', { sizes: 64 as never }, /sizes/],
		['duplicate sizes', { sizes: [64, 64] }, /sizes.*unique/],
		['a fractional size', { sizes: [64.5] }, /sizes/],
		['a zero size', { sizes: [0] }, /sizes/],
		['a size over 4096', { sizes: [4097] }, /sizes/],
		['a string size', { sizes: ['64' as never] }, /sizes/],
		['maxBytes 0', { maxBytes: 0 }, /maxBytes/],
		['maxBytes fractional', { maxBytes: 1.5 }, /maxBytes/],
		['maxBytes NaN', { maxBytes: Number.NaN }, /maxBytes/],
		['maxPixels 0', { maxPixels: 0 }, /maxPixels/],
		[
			'maxPixels Infinity',
			{ maxPixels: Number.POSITIVE_INFINITY },
			/maxPixels/,
		],
		['minSide 0', { minSide: 0 }, /minSide/],
		['minSide fractional', { minSide: 2.5 }, /minSide/],
		['quality 0', { quality: 0 }, /quality/],
		['quality 101', { quality: 101 }, /quality/],
		['concurrency 0', { concurrency: 0 }, /concurrency/],
		['concurrency 65', { concurrency: 65 }, /concurrency/],
		['concurrency fractional', { concurrency: 1.5 }, /concurrency/],
		['quality fractional', { quality: 80.5 }, /quality/],
	];
	for (const [name, options, message] of invalid) {
		test(`${name} is a TypeError naming the option`, () => {
			expect(() => defineImageSet(options)).toThrow(TypeError);
			expect(() => defineImageSet(options)).toThrow(message);
		});
	}
});

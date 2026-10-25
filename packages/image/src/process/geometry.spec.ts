import { describe, expect, test } from 'bun:test';
import { ImageError } from '../errors/image-error';
import {
	assertCropFits,
	assertCropShape,
	centredCrop,
	scaleCrop,
	scaledDimensions,
	shrinkScale,
} from './geometry';

describe('shrinkScale', () => {
	test('keeps twice the largest size, and never enlarges', () => {
		expect(shrinkScale(2048, 256)).toBe(0.25);
		expect(shrinkScale(512, 256)).toBe(1);
		expect(shrinkScale(300, 256)).toBe(1);
	});
});

describe('scaledDimensions', () => {
	test('rounds, and keeps one pixel at least', () => {
		expect(scaledDimensions({ width: 4712, height: 3044 }, 512 / 3044)).toEqual(
			{ width: 793, height: 512 },
		);
		expect(scaledDimensions({ width: 10, height: 1 }, 0.01)).toEqual({
			width: 1,
			height: 1,
		});
	});
});

describe('centredCrop', () => {
	test('is the middle square of the short side', () => {
		expect(centredCrop({ width: 100, height: 60 })).toEqual({
			x: 20,
			y: 0,
			size: 60,
		});
		expect(centredCrop({ width: 60, height: 101 })).toEqual({
			x: 0,
			y: 20,
			size: 60,
		});
		// An odd margin (1 px): the first pixel is the floor, never the ceil.
		expect(centredCrop({ width: 61, height: 60 })).toEqual({
			x: 0,
			y: 0,
			size: 60,
		});
		expect(centredCrop({ width: 103, height: 60 })).toEqual({
			x: 21,
			y: 0,
			size: 60,
		});
		expect(centredCrop({ width: 7, height: 7 })).toEqual({
			x: 0,
			y: 0,
			size: 7,
		});
	});
});

function codeOf(run: () => void): string | undefined {
	try {
		run();
	} catch (error) {
		return (error as ImageError).code;
	}
	return undefined;
}

describe('crop checks', () => {
	test('a shape that is not whole non-negative numbers is INVALID_CROP', () => {
		for (const crop of [
			{ x: -1, y: 0, size: 10 },
			{ x: 0.5, y: 0, size: 10 },
			{ x: 0, y: 0, size: Number.NaN },
			{ x: 0, y: 0, size: Number.POSITIVE_INFINITY },
			{ x: '1', y: 0, size: 10 } as never,
		]) {
			expect(() => assertCropShape(crop)).toThrow(ImageError);
			expect(codeOf(() => assertCropShape(crop))).toBe('INVALID_CROP');
		}
		expect(() => assertCropShape({ x: 0, y: 0, size: 0 })).not.toThrow();
	});

	test('a crop must fit the image, to the last pixel', () => {
		const image = { width: 30, height: 60 };
		expect(() =>
			assertCropFits({ x: 0, y: 30, size: 30 }, image),
		).not.toThrow();
		for (const crop of [
			{ x: 1, y: 0, size: 30 },
			{ x: 0, y: 31, size: 30 },
			{ x: 0, y: 0, size: 31 },
			{ x: 0, y: 0, size: 0 },
		]) {
			expect(codeOf(() => assertCropFits(crop, image))).toBe('INVALID_CROP');
		}
	});
});

describe('scaleCrop', () => {
	test('rounds each number', () => {
		expect(
			scaleCrop({ x: 100, y: 50, size: 200 }, 0.5, { width: 200, height: 150 }),
		).toEqual({ x: 50, y: 25, size: 100 });
	});

	test('rounds halves up, so no number is floored', () => {
		// 3 x 0.5 = 1.5, 5 x 0.5 = 2.5, 7 x 0.5 = 3.5: round gives 2, 3, 4.
		expect(
			scaleCrop({ x: 3, y: 5, size: 7 }, 0.5, { width: 20, height: 20 }),
		).toEqual({ x: 2, y: 3, size: 4 });
	});

	test('clamps a rounded square back inside the image', () => {
		// 0.4 * 999 = 399.6 -> 400 would reach past the 399 pixel edge.
		const shrunk = { width: 399, height: 400 };
		const box = scaleCrop({ x: 1, y: 0, size: 999 }, 0.4, shrunk);
		expect(box.size).toBe(399);
		expect(box.x + box.size).toBeLessThanOrEqual(shrunk.width);
		expect(box.y + box.size).toBeLessThanOrEqual(shrunk.height);
	});

	test('is the whole image at scale 1', () => {
		expect(
			scaleCrop({ x: 3, y: 4, size: 10 }, 1, { width: 20, height: 20 }),
		).toEqual({ x: 3, y: 4, size: 10 });
	});
});

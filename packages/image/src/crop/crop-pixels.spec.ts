import { describe, expect, test } from 'bun:test';
import { pattern } from '../../test/images';
import { cropPixels } from './crop-pixels';

describe('cropPixels', () => {
	test('cuts the square at an offset, exactly', () => {
		for (const channels of [3, 4] as const) {
			const image = pattern(20, 12, channels);
			const cut = cropPixels(image, { x: 5, y: 3, size: 6 });
			expect([cut.width, cut.height, cut.channels]).toEqual([6, 6, channels]);
			for (let y = 0; y < 6; y++) {
				for (let x = 0; x < 6; x++) {
					for (let c = 0; c < channels; c++) {
						expect(cut.pixels[(y * 6 + x) * channels + c]).toBe(
							image.pixels[((y + 3) * 20 + x + 5) * channels + c],
						);
					}
				}
			}
		}
	});

	test('takes the whole image when it is already the square', () => {
		const image = pattern(8, 8, 4);
		expect(cropPixels(image, { x: 0, y: 0, size: 8 })).toEqual(image);
	});

	test('a square that does not fit is a RangeError', () => {
		const image = pattern(10, 10, 3);
		expect(() => cropPixels(image, { x: 5, y: 0, size: 6 })).toThrow(
			RangeError,
		);
		expect(() => cropPixels(image, { x: 0, y: 5, size: 6 })).toThrow(
			RangeError,
		);
		expect(() => cropPixels(image, { x: -1, y: 0, size: 2 })).toThrow(
			RangeError,
		);
		expect(() => cropPixels(image, { x: 0, y: 0, size: 0 })).toThrow(
			RangeError,
		);
		expect(() => cropPixels(image, { x: 0.5, y: 0, size: 2 })).toThrow(
			RangeError,
		);
	});
});

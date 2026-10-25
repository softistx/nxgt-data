import { describe, expect, test } from 'bun:test';
import { pattern, writePng } from '../../test/images';
import { withExif } from '../../test/metadata';
import { isNear, PALETTE, pixelsOf, sample, scene } from '../../test/scene';
import { sniffFormat } from '../input/sniff';
import { defineImageSet } from '../set/define-image-set';
import type { ProcessedImage } from '../set/types';

const set = defineImageSet({ sizes: [64, 32] });
const colour = (row: number, column: number) =>
	PALETTE[row]?.[column] as readonly number[];

/** The variant of a size, as pixels. */
async function variantPixels(result: ProcessedImage, size: number) {
	const variant = result.variants.find((v) => v.size === size);
	if (!variant) throw new Error(`no ${size}px variant`);
	return pixelsOf(variant.bytes);
}

async function expectQuadrants(
	result: ProcessedImage,
	[topLeft, topRight, bottomLeft, bottomRight]: (readonly number[])[],
) {
	for (const size of [64, 32]) {
		const pixels = await variantPixels(result, size);
		expect(isNear(sample(pixels, 0.25, 0.25), topLeft as number[])).toBe(true);
		expect(isNear(sample(pixels, 0.75, 0.25), topRight as number[])).toBe(true);
		expect(isNear(sample(pixels, 0.25, 0.75), bottomLeft as number[])).toBe(
			true,
		);
		expect(isNear(sample(pixels, 0.75, 0.75), bottomRight as number[])).toBe(
			true,
		);
	}
}

const heic = await new Bun.Image(writePng(pattern(200, 100, 3)))
	.heic()
	.bytes()
	.catch((error: { code?: string }) => {
		if (error.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') return undefined;
		throw error;
	});

describe('process: outputs', () => {
	const source = writePng(pattern(300, 200, 3));
	const inputs: [string, () => Promise<Uint8Array | undefined>][] = [
		['jpeg', () => new Bun.Image(source).jpeg().bytes()],
		['png', async () => source],
		['webp', () => new Bun.Image(source).webp().bytes()],
		['heic', async () => heic],
	];
	for (const [name, make] of inputs) {
		const skip = name === 'heic' && heic === undefined;
		const title = `${name} gives the configured sizes as WebP${skip ? ' (skipped: this machine cannot encode HEIC)' : ''}`;
		test.skipIf(skip)(title, async () => {
			const bytes = (await make()) as Uint8Array;
			const result = await set.process(bytes);
			expect(result.source.width).toBe(name === 'heic' ? 200 : 300);
			expect(result.variants.map((v) => v.size)).toEqual([64, 32]);
			for (const variant of result.variants) {
				expect(sniffFormat(variant.bytes)).toBe('webp');
				expect(variant.contentType).toBe('image/webp');
				expect(variant.width).toBe(variant.size);
				expect(variant.height).toBe(variant.size);
				const meta = await new Bun.Image(variant.bytes).metadata();
				expect([meta.format, meta.width, meta.height]).toEqual([
					'webp',
					variant.size,
					variant.size,
				]);
			}
		});
	}

	test('takes a Blob, an ArrayBuffer and a stream like bytes', async () => {
		const bytes = writePng(pattern(100, 100, 3));
		const blob = new Blob([bytes as BlobPart]);
		const stream = blob.stream() as ReadableStream<Uint8Array>;
		for (const input of [blob, bytes.slice().buffer, stream]) {
			expect((await set.process(input)).variants).toHaveLength(2);
		}
	});

	test('keeps the order of sizes, whatever it is', async () => {
		const result = await defineImageSet({ sizes: [16, 48, 32] }).process(
			writePng(scene()),
		);
		expect(result.variants.map((v) => v.size)).toEqual([16, 48, 32]);
	});
});

describe('process: crop', () => {
	test('is the centred square by default, proven by colours', async () => {
		// 400x200: the centre square is x 100..299, the green and blue blocks.
		const result = await set.process(writePng(scene()));
		expect(result.source).toEqual({ format: 'png', width: 400, height: 200 });
		const green = colour(0, 1);
		const blue = colour(0, 2);
		const cyan = colour(1, 1);
		const white = colour(1, 2);
		await expectQuadrants(result, [green, blue, cyan, white]);
	});

	test('follows a caller crop box, proven by colours', async () => {
		// 100 px at (50, 50) straddles the four blocks of columns 0 and 1.
		const result = await set.process(writePng(scene()), {
			crop: { x: 50, y: 50, size: 100 },
		});
		await expectQuadrants(result, [
			colour(0, 0),
			colour(0, 1),
			colour(1, 0),
			colour(1, 1),
		]);
	});

	test('a crop at the far corner lands on the last blocks', async () => {
		const result = await set.process(writePng(scene()), {
			crop: { x: 200, y: 100, size: 100 },
		});
		const pixels = await variantPixels(result, 64);
		expect(isNear(sample(pixels, 0.5, 0.5), colour(1, 2) as number[])).toBe(
			true,
		);
		expect(isNear(sample(pixels, 0.9, 0.9), colour(1, 2) as number[])).toBe(
			true,
		);
	});

	test('a crop is scaled with the shrink of a large source', async () => {
		// A 400 px crop keeps 128 px: the 1200x600 source shrinks to 0.32.
		const big = new Uint8Array(1200 * 600 * 3);
		for (let y = 0; y < 600; y++) {
			for (let x = 0; x < 1200; x++) {
				const c = colour(Math.floor(y / 300), Math.floor(x / 300));
				big.set(c as number[], (y * 1200 + x) * 3);
			}
		}
		const png = writePng({
			width: 1200,
			height: 600,
			channels: 3,
			pixels: big,
		});
		const result = await set.process(png, {
			crop: { x: 100, y: 100, size: 400 },
		});
		await expectQuadrants(result, [
			colour(0, 0),
			colour(0, 1),
			colour(1, 0),
			colour(1, 1),
		]);
	});

	test('respects EXIF orientation 6: the crop is in the oriented frame', async () => {
		const jpeg = await new Bun.Image(writePng(scene()))
			.jpeg({ quality: 95 })
			.bytes();
		const rotated = withExif(jpeg, { orientation: 6 });
		const result = await set.process(rotated);
		// Stored 400x200 shows as 200x400; its centred square is the stored
		// columns 1 and 2, turned a quarter clockwise: stored rows 1 / 0 left / right.
		expect(result.source).toEqual({ format: 'jpeg', width: 200, height: 400 });
		await expectQuadrants(result, [
			colour(1, 1),
			colour(0, 1),
			colour(1, 2),
			colour(0, 2),
		]);
		// A crop box is read in that frame too: the top 200 px, stored columns 0 and 1.
		const top = await set.process(rotated, { crop: { x: 0, y: 0, size: 200 } });
		await expectQuadrants(top, [
			colour(1, 0),
			colour(0, 0),
			colour(1, 1),
			colour(0, 1),
		]);
	});

	test('a source under twice the largest size is not resized', async () => {
		// 100x100 < 2 x 64: no shrink, so a one-pixel feature survives the crop.
		const image = scene(1, 1);
		const result = await set.process(writePng(image));
		expect(result.source).toEqual({ format: 'png', width: 100, height: 100 });
		const pixels = await variantPixels(result, 64);
		expect(isNear(sample(pixels, 0.5, 0.5), colour(0, 0) as number[])).toBe(
			true,
		);
	});

	test('a PNG with alpha keeps its transparency', async () => {
		const width = 100;
		const pixels = new Uint8Array(width * width * 4);
		for (let y = 0; y < width; y++) {
			for (let x = 0; x < width; x++) {
				pixels.set(
					x < 50 ? [255, 0, 0, 0] : [0, 0, 255, 255],
					(y * width + x) * 4,
				);
			}
		}
		const result = await set.process(
			writePng({ width, height: width, channels: 4, pixels }),
		);
		const out = await variantPixels(result, 64);
		expect(out.channels).toBe(4);
		expect(sample(out, 0.2, 0.5)[3]).toBeLessThan(10);
		const right = sample(out, 0.8, 0.5);
		expect(right[3]).toBeGreaterThan(245);
		expect(isNear(right, [0, 0, 255])).toBe(true);
	});
});

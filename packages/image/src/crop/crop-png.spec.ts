import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { concat, decodePng, pattern, writePng } from '../../test/images';
import { rejection } from '../../test/rejection';
import { ImageError } from '../errors/image-error';
import { cropPng } from './crop-png';
import { chunk, encodePng, type RawImage } from './png';

const rgba = pattern(37, 29, 4);

/** The call is refused as UNDECODABLE, with this text in its message. */
async function refused(run: Promise<unknown>, text: string) {
	const error = await rejection(run);
	expect(error).toBeInstanceOf(ImageError);
	expect((error as ImageError).code).toBe('UNDECODABLE');
	expect((error as ImageError).reason).toBe('decode');
	expect((error as ImageError).message).toContain(text);
}

/** The pixels of a region of `image`, taken by hand. */
function cut(
	image: RawImage,
	x: number,
	y: number,
	width: number,
	height: number,
) {
	const out = new Uint8Array(width * height * image.channels);
	for (let row = 0; row < height; row++) {
		const from = ((y + row) * image.width + x) * image.channels;
		out.set(
			image.pixels.subarray(from, from + width * image.channels),
			row * width * image.channels,
		);
	}
	return out;
}

describe('cropPng: a region', () => {
	const wide = pattern(60, 40, 4);

	test('is exactly the pixels there, whatever the filters and the channels', async () => {
		for (const image of [pattern(60, 40, 3), wide]) {
			for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
				const png = writePng(image, { filters });
				const got = await cropPng(png, { x: 7, y: 5, width: 20, height: 11 });
				expect([got.width, got.height, got.channels]).toEqual([
					20,
					11,
					image.channels,
				]);
				expect(got.pixels).toEqual(cut(image, 7, 5, 20, 11));
			}
		}
	});

	test('reaches the last row and the last column', async () => {
		const png = writePng(wide, { filters: [4, 1] });
		const got = await cropPng(png, { x: 40, y: 20, width: 20, height: 20 });
		expect(got.pixels).toEqual(cut(wide, 40, 20, 20, 20));
	});

	test('takes the region from a function of the header size', async () => {
		const got = await cropPng(writePng(wide), ({ width, height }) => ({
			x: width - 10,
			y: height - 10,
			width: 10,
			height: 10,
		}));
		expect(got.pixels).toEqual(cut(wide, 50, 30, 10, 10));
	});

	test('a region that does not fit is a RangeError', async () => {
		const png = writePng(wide);
		for (const region of [
			{ x: 41, y: 0, width: 20, height: 5 },
			{ x: 0, y: 36, width: 5, height: 5 },
			{ x: -1, y: 0, width: 5, height: 5 },
			{ x: 0, y: 0, width: 0, height: 5 },
			{ x: 0.5, y: 0, width: 5, height: 5 },
		]) {
			expect(await rejection(cropPng(png, region))).toBeInstanceOf(RangeError);
		}
	});

	test('an early stop cancels the stream and leaves no unhandled rejection', async () => {
		const seen: unknown[] = [];
		const listener = (reason: unknown) => seen.push(reason);
		process.on('unhandledRejection', listener);
		try {
			// A large image Bun splits across many IDAT chunks, cropped at the top.
			const big = pattern(600, 300, 4);
			const png = await new Bun.Image(encodePng(big))
				.png({ compressionLevel: 0 })
				.bytes();
			for (let i = 0; i < 20; i++) {
				const got = await cropPng(png, { x: 0, y: 0, width: 50, height: 2 });
				expect(got.pixels).toEqual(cut(big, 0, 0, 50, 2));
			}
			await Bun.sleep(50);
			expect(seen).toEqual([]);
		} finally {
			process.off('unhandledRejection', listener);
		}
	});

	test('stops after the last row it needs: what follows is never read', async () => {
		// The zlib stream holds the right rows, then a megabyte more.
		const rows = writePng(wide, { filters: [0] });
		const header = rows.subarray(0, 33);
		const real = new Uint8Array((60 * 4 + 1) * 40);
		const filtered = new Uint8Array(real.length);
		for (let y = 0; y < 40; y++) {
			filtered.set(wide.pixels.subarray(y * 240, (y + 1) * 240), y * 241 + 1);
		}
		const long = concat([filtered, new Uint8Array(1_000_000)]);
		const png = concat([
			header,
			chunk('IDAT', deflateSync(long)),
			chunk('IEND', new Uint8Array(0)),
		]);
		const top = await cropPng(png, { x: 0, y: 0, width: 60, height: 5 });
		expect(top.pixels).toEqual(cut(wide, 0, 0, 60, 5));
		// Reaching the last row reads on, and finds the surplus.
		await refused(
			cropPng(png, { x: 0, y: 30, width: 60, height: 10 }),
			'longer than the header says',
		);
	});
});

describe('cropPng: refusals', () => {
	const whole = ({ width, height }: { width: number; height: number }) => ({
		x: 0,
		y: 0,
		width,
		height,
	});

	test('refuses what it does not read, as UNDECODABLE', async () => {
		await refused(
			decodePng(writePng(rgba, { depth: 16 })),
			'only 8-bit samples',
		);
		await refused(decodePng(writePng(rgba, { colour: 3 })), 'a palette');
		await refused(decodePng(writePng(rgba, { interlace: 1 })), 'interlaced');
		await refused(
			decodePng(writePng(rgba, { idat: new Uint8Array([1, 2, 3, 4, 5, 6]) })),
			'not valid zlib',
		);
		await refused(
			decodePng(writePng(rgba, { idat: deflateSync(new Uint8Array(10)) })),
			'shorter than the header says',
		);
		await refused(decodePng(encodePng(rgba).subarray(0, 40)), 'no IEND');
		await refused(decodePng(encodePng(rgba).subarray(0, 60)), 'cut short');
		await refused(decodePng(new Uint8Array([1, 2, 3])), 'no PNG signature');
		await refused(
			decodePng(writePng(rgba, { filters: [9] })),
			'unknown filter',
		);
	});

	test('refuses a stream that inflates past what the header promises', async () => {
		const bomb = deflateSync(new Uint8Array(1_000_000));
		await refused(
			decodePng(writePng(rgba, { idat: bomb })),
			'longer than the header says',
		);
	});

	test('a missing IHDR or IDAT is refused', async () => {
		const png = encodePng(rgba);
		const iend = chunk('IEND', new Uint8Array(0));
		const signature = png.subarray(0, 8);
		await refused(decodePng(concat([signature, iend])), 'no IHDR');
		await refused(
			decodePng(concat([signature, png.subarray(8, 33), iend])),
			'no IDAT',
		);
	});

	test('refuses, before inflating, a header over maxPixels', async () => {
		const png = writePng(pattern(20, 10, 4));
		expect((await decodePng(png, 200)).width).toBe(20);
		for (const bytes of [
			png,
			// A body that would not inflate: the cap is judged first.
			writePng(pattern(20, 10, 4), { idat: new Uint8Array([1, 2, 3]) }),
		]) {
			const error = await rejection(cropPng(bytes, whole, 199));
			expect(error).toBeInstanceOf(ImageError);
			expect((error as ImageError).code).toBe('TOO_LARGE');
			expect((error as ImageError).reason).toBe('pixels');
		}
	});
});

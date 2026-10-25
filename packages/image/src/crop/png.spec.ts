import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { concat, decodePng, pattern, writePng } from '../../test/images';
import { cropPng } from './crop-png';
import { chunk, encodePng } from './png';

const rgb = pattern(37, 29, 3);
const rgba = pattern(37, 29, 4);

function chunkTypes(png: Uint8Array): string[] {
	const view = new DataView(png.buffer, png.byteOffset);
	const types: string[] = [];
	for (let at = 8; at < png.length; at += 12 + view.getUint32(at)) {
		types.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
	}
	return types;
}

/** What Bun's PNG output is, read back as RGBA pixels. */
async function throughBun(
	image: typeof rgb,
	compressionLevel: number,
): Promise<Uint8Array> {
	return new Bun.Image(await encodePng(image))
		.png({ compressionLevel })
		.bytes();
}

describe('png codec', () => {
	test('round trips exact pixels, RGB and RGBA', async () => {
		expect(await decodePng(await encodePng(rgb))).toEqual(rgb);
		expect(await decodePng(await encodePng(rgba))).toEqual(rgba);
	});

	test('reads Bun.Image output at compression level 0 and 9', async () => {
		for (const source of [rgb, rgba]) {
			for (const level of [0, 9]) {
				const decoded = await decodePng(await throughBun(source, level));
				// Bun writes RGBA whatever the source: an RGB source gains opaque alpha.
				expect(decoded.channels).toBe(4);
				expect(decoded.width).toBe(source.width);
				for (let i = 0; i < source.width * source.height; i++) {
					for (let c = 0; c < source.channels; c++) {
						expect(decoded.pixels[i * 4 + c]).toBe(
							source.pixels[i * source.channels + c],
						);
					}
					if (source.channels === 3)
						expect(decoded.pixels[i * 4 + 3]).toBe(255);
				}
			}
		}
	});

	test('reads a large image Bun split across many IDAT chunks', async () => {
		const big = pattern(600, 300, 4);
		const out = await throughBun(big, 0);
		expect(
			chunkTypes(out).filter((type) => type === 'IDAT').length,
		).toBeGreaterThan(1);
		expect(await decodePng(out)).toEqual(big);
	});

	test('undoes each of the five filters', async () => {
		for (const filter of [0, 1, 2, 3, 4]) {
			expect(await decodePng(writePng(rgb, { filters: [filter] }))).toEqual(
				rgb,
			);
			expect(await decodePng(writePng(rgba, { filters: [filter] }))).toEqual(
				rgba,
			);
		}
		expect(
			await decodePng(writePng(rgba, { filters: [0, 1, 2, 3, 4] })),
		).toEqual(rgba);
	});

	test('widens 8-bit grey and grey with alpha', async () => {
		const grey = {
			width: 3,
			height: 2,
			channels: 3 as const,
			pixels: new Uint8Array(18),
		};
		const plain = new Uint8Array([10, 20, 30, 40, 50, 60]);
		for (let i = 0; i < 6; i++)
			grey.pixels.fill(plain[i] as number, i * 3, i * 3 + 3);
		// writePng takes `channels` as the sample count for the pixels it is given.
		const g = writePng(
			{ width: 3, height: 2, channels: 1 as never, pixels: plain },
			{ colour: 0, filters: [1, 4] },
		);
		expect(await decodePng(g)).toEqual(grey);

		const ga = new Uint8Array([10, 255, 20, 128, 30, 0, 40, 1, 50, 2, 60, 3]);
		const decoded = await decodePng(
			writePng(
				{ width: 3, height: 2, channels: 2 as never, pixels: ga },
				{ colour: 4, filters: [2, 3] },
			),
		);
		expect(decoded.channels).toBe(4);
		expect([...decoded.pixels.subarray(0, 8)]).toEqual([
			10, 10, 10, 255, 20, 20, 20, 128,
		]);
		// A region of a grey image is widened too.
		const part = await cropPng(g, { x: 1, y: 1, width: 2, height: 1 });
		expect([...part.pixels]).toEqual([50, 50, 50, 60, 60, 60]);
	});

	test('output of encodePng is a PNG Bun reads', async () => {
		const metadata = await new Bun.Image(await encodePng(rgba)).metadata();
		expect(metadata).toEqual({ width: 37, height: 29, format: 'png' });
	});

	test('drops ancillary chunks on read then encode', async () => {
		const text = new TextEncoder();
		const noisy = writePng(rgba, {
			extra: [
				chunk(
					'iCCP',
					concat([text.encode('profile\0\0'), deflateSync(new Uint8Array(32))]),
				),
				chunk('eXIf', text.encode('MM\0*')),
				chunk('tEXt', text.encode('Author\0someone')),
			],
		});
		expect(chunkTypes(noisy)).toEqual([
			'IHDR',
			'iCCP',
			'eXIf',
			'tEXt',
			'IDAT',
			'IEND',
		]);
		const clean = await encodePng(await decodePng(noisy));
		expect(chunkTypes(clean)).toEqual(['IHDR', 'IDAT', 'IEND']);
		expect(await decodePng(clean)).toEqual(rgba);
	});
});

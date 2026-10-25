import { describe, expect, test } from 'bun:test';
import { concat, ftyp, pattern, writePng } from '../../test/images';
import { rejection } from '../../test/rejection';
import { scene } from '../../test/scene';
import { chunk } from '../crop/png';
import { ImageError } from '../errors/image-error';
import { defineImageSet } from '../set/define-image-set';

const set = defineImageSet({ sizes: [64, 32] });
const png = writePng(scene());

async function refused(
	promise: Promise<unknown>,
	code: string,
	reason: string,
): Promise<ImageError> {
	const error = await rejection(promise);
	expect(error).toBeInstanceOf(ImageError);
	expect((error as ImageError).code).toBe(code as never);
	expect((error as ImageError).reason).toBe(reason as never);
	return error as ImageError;
}

const heic = await new Bun.Image(writePng(pattern(200, 100, 3)))
	.heic()
	.bytes()
	.catch((error: { code?: string }) => {
		if (error.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') return undefined;
		throw error;
	});

describe('process: refusals', () => {
	test('over maxBytes: TOO_LARGE bytes', async () => {
		const small = defineImageSet({ sizes: [64], maxBytes: png.length - 1 });
		await refused(small.process(png), 'TOO_LARGE', 'bytes');
	});

	test('over maxPixels: TOO_LARGE pixels, Bun error kept as the cause', async () => {
		const small = defineImageSet({ sizes: [64], maxPixels: 100 * 100 });
		const error = await refused(small.process(png), 'TOO_LARGE', 'pixels');
		expect((error.cause as { code?: string }).code).toBe(
			'ERR_IMAGE_TOO_MANY_PIXELS',
		);
	});

	test('gif, avif and garbage: UNSUPPORTED_TYPE format', async () => {
		const gif = Buffer.from(
			'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
			'base64',
		);
		const avif = concat([ftyp('avif', ['mif1', 'miaf']), new Uint8Array(64)]);
		const garbage = new Uint8Array(500).map((_, i) => (i * 31) & 0xff);
		for (const input of [
			new Uint8Array(gif),
			avif,
			garbage,
			new Uint8Array(),
		]) {
			await refused(set.process(input), 'UNSUPPORTED_TYPE', 'format');
		}
	});

	test('a PNG signature over a corrupt body: UNDECODABLE decode', async () => {
		const signature = png.subarray(0, 8);
		const corrupt = concat([
			signature,
			chunk('IHDR', png.subarray(16, 29)),
			chunk('IDAT', new Uint8Array([1, 2, 3, 4, 5])),
			chunk('IEND', new Uint8Array()),
		]);
		await refused(set.process(corrupt), 'UNDECODABLE', 'decode');
		await refused(set.process(signature), 'UNDECODABLE', 'decode');
	});

	test('a truncated WebP: UNDECODABLE decode', async () => {
		const webp = await new Bun.Image(png).webp().bytes();
		await refused(
			set.process(webp.subarray(0, Math.floor(webp.length / 2))),
			'UNDECODABLE',
			'decode',
		);
	});

	test('under minSide: TOO_SMALL dimensions, without a crop', async () => {
		// The default minSide is the largest size, 64: this is 63 x 200.
		const thin = writePng(pattern(63, 200, 3));
		await refused(set.process(thin), 'TOO_SMALL', 'dimensions');
		const fine = writePng(pattern(64, 200, 3));
		expect((await set.process(fine)).variants).toHaveLength(2);
	});

	test('under minSide: TOO_SMALL dimensions, with a crop', async () => {
		await refused(
			set.process(png, { crop: { x: 0, y: 0, size: 63 } }),
			'TOO_SMALL',
			'dimensions',
		);
		const wide = defineImageSet({ sizes: [64], minSide: 150 });
		await refused(
			wide.process(png, { crop: { x: 0, y: 0, size: 149 } }),
			'TOO_SMALL',
			'dimensions',
		);
	});

	test("a crop that is the caller's bug is a RangeError, not a refusal", async () => {
		for (const crop of [
			{ x: -1, y: 0, size: 100 },
			{ x: 0.5, y: 0, size: 100 },
			{ x: 0, y: 0, size: Number.NaN },
			{ x: 350, y: 0, size: 100 },
			{ x: 0, y: 101, size: 100 },
			{ x: 0, y: 0, size: 201 },
		]) {
			expect(await rejection(set.process(png, { crop }))).toBeInstanceOf(
				RangeError,
			);
		}
	});

	test.skipIf(heic === undefined)(
		`a HEIC that decodes here is processed${heic === undefined ? ' (skipped: this machine cannot encode HEIC)' : ''}`,
		async () => {
			expect((await set.process(heic as Uint8Array)).source.format).toBe(
				'heic',
			);
		},
	);

	test('a HEIC under the "bun" backend: UNSUPPORTED_TYPE heic-unavailable, on every machine', async () => {
		// Built by hand: it needs no HEIC encoder, so it runs on Linux CI too.
		const input = concat([ftyp('heic', ['mif1']), new Uint8Array(64)]);
		const before = Bun.Image.backend;
		Bun.Image.backend = 'bun';
		try {
			const error = await refused(
				set.process(input),
				'UNSUPPORTED_TYPE',
				'heic-unavailable',
			);
			expect((error.cause as { code?: string }).code).toBe(
				'ERR_IMAGE_FORMAT_UNSUPPORTED',
			);
		} finally {
			Bun.Image.backend = before;
		}
	});
});

import { describe, expect, test } from 'bun:test';
import { ftyp, pattern } from '../../test/images';
import { encodePng } from '../crop/png';
import { sniffFormat } from './sniff';

const source = pattern(16, 16, 4);

async function encoded(
	format: 'jpeg' | 'webp' | 'heic',
): Promise<Uint8Array | undefined> {
	const image = new Bun.Image(await encodePng(source));
	try {
		return await (format === 'jpeg'
			? image.jpeg()
			: format === 'webp'
				? image.webp()
				: image.heic()
		).bytes();
	} catch (error) {
		if ((error as { code?: string }).code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
			return undefined;
		}
		throw error;
	}
}

const heic = await encoded('heic');

describe('sniffFormat', () => {
	test('reads a PNG, a JPEG and a WebP made by Bun', async () => {
		expect(sniffFormat(await encodePng(source))).toBe('png');
		expect(sniffFormat((await encoded('jpeg')) as Uint8Array)).toBe('jpeg');
		expect(sniffFormat((await encoded('webp')) as Uint8Array)).toBe('webp');
	});

	test.skipIf(heic === undefined)(
		`reads a HEIC made by Bun, where this machine can make one${heic === undefined ? ' (skipped: this machine cannot encode HEIC)' : ''}`,
		() => {
			expect(sniffFormat(heic as Uint8Array)).toBe('heic');
		},
	);

	test('reads a HEIC by its major or by a compatible brand', () => {
		for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']) {
			expect(sniffFormat(ftyp(brand, []))).toBe('heic');
		}
		expect(sniffFormat(ftyp('isom', ['iso2', 'heic']))).toBe('heic');
	});

	test('does not take heim and heis for HEIC: Bun does not recognise them', () => {
		expect(sniffFormat(ftyp('heim', []))).toBeUndefined();
		expect(sniffFormat(ftyp('heis', []))).toBeUndefined();
	});

	test('refuses AVIF, by its major or a compatible brand', () => {
		expect(sniffFormat(ftyp('avif', ['mif1']))).toBeUndefined();
		expect(sniffFormat(ftyp('mif1', ['avif', 'miaf']))).toBeUndefined();
		expect(sniffFormat(ftyp('avis', []))).toBeUndefined();
	});

	test('does not read a brand past the size the box declares', () => {
		const box = ftyp('isom', ['iso2']);
		const longer = new Uint8Array(box.length + 4);
		longer.set(box);
		longer.set(new TextEncoder().encode('heic'), box.length);
		expect(sniffFormat(longer)).toBeUndefined();
	});

	test('returns undefined for short, truncated and garbage input', async () => {
		const png = await encodePng(source);
		const webp = (await encoded('webp')) as Uint8Array;
		expect(sniffFormat(new Uint8Array())).toBeUndefined();
		expect(sniffFormat(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
		expect(sniffFormat(png.subarray(0, 7))).toBeUndefined();
		expect(sniffFormat(webp.subarray(0, 11))).toBeUndefined();
		expect(sniffFormat(ftyp('heic', []).subarray(0, 11))).toBeUndefined();
		expect(
			sniffFormat(new TextEncoder().encode('GIF89a not an image')),
		).toBeUndefined();
		expect(
			sniffFormat(crypto.getRandomValues(new Uint8Array(64)).fill(0, 0, 4)),
		).toBeUndefined();
	});
});

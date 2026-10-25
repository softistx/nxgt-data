import { describe, expect, test } from 'bun:test';
import { pattern } from '../../test/images';
import { encodePng } from '../crop/png';
import { sniffFormat } from './sniff';

const source = pattern(16, 16, 4);

async function encoded(
	format: 'jpeg' | 'webp' | 'heic',
): Promise<Uint8Array | undefined> {
	const image = new Bun.Image(encodePng(source));
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

function ftyp(major: string, compatible: string[]): Uint8Array {
	const brands = [major, '\0\0\0\0', ...compatible].join('');
	const out = new Uint8Array(8 + brands.length);
	new DataView(out.buffer).setUint32(0, out.length);
	out.set(new TextEncoder().encode(`ftyp${brands}`), 4);
	return out;
}

describe('sniffFormat', () => {
	test('reads a PNG, a JPEG and a WebP made by Bun', async () => {
		expect(sniffFormat(encodePng(source))).toBe('png');
		expect(sniffFormat((await encoded('jpeg')) as Uint8Array)).toBe('jpeg');
		expect(sniffFormat((await encoded('webp')) as Uint8Array)).toBe('webp');
	});

	test('reads a HEIC made by Bun, where this machine can make one', async () => {
		const heic = await encoded('heic');
		if (!heic) {
			console.warn(
				'skipped: this machine cannot encode HEIC (ERR_IMAGE_FORMAT_UNSUPPORTED)',
			);
			return;
		}
		expect(sniffFormat(heic)).toBe('heic');
	});

	test('reads a HEIC by its major or by a compatible brand', () => {
		for (const brand of [
			'heic',
			'heix',
			'heim',
			'heis',
			'hevc',
			'hevx',
			'mif1',
			'msf1',
		]) {
			expect(sniffFormat(ftyp(brand, []))).toBe('heic');
		}
		expect(sniffFormat(ftyp('isom', ['iso2', 'heic']))).toBe('heic');
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
		const png = encodePng(source);
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

import { deflateSync, inflateSync } from 'node:zlib';
import { ImageError } from '../errors/image-error';
import { unfilter } from './unfilter';

/** Decoded pixels, row after row, `channels` bytes each: RGB or RGBA. */
export type RawImage = {
	width: number;
	height: number;
	channels: 3 | 4;
	pixels: Uint8Array;
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function refuse(why: string): ImageError {
	return new ImageError(
		'UNDECODABLE',
		'decode',
		`the PNG cannot be read: ${why}`,
	);
}

/** Every chunk of the file, in order: its type and a view of its data. */
function chunksOf(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
	if (!SIGNATURE.every((value, i) => bytes[i] === value)) {
		throw refuse('no PNG signature');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: { type: string; data: Uint8Array }[] = [];
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		if (at + 12 + length > bytes.length) throw refuse('a chunk is cut short');
		chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
		at += 12 + length;
		if (type === 'IEND') return chunks;
	}
	throw refuse('no IEND chunk');
}

/**
 * Decodes what `Bun.Image(...).png()` emits: 8-bit, not interlaced, RGB or
 * RGBA, any of the five filters. 8-bit grey and grey with alpha are widened
 * to RGB and RGBA. Every other chunk (colour profile, EXIF, text) is read
 * past and dropped, which is how a re-encode strips them. A chunk's CRC is
 * not checked; the zlib stream's own checksum is.
 *
 * `maxPixels` refuses a PNG whose header claims more pixels, before anything
 * is inflated: `TOO_LARGE` with the reason `pixels`.
 */
export function decodePng(bytes: Uint8Array, maxPixels?: number): RawImage {
	const chunks = chunksOf(bytes);
	const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
	if (header === undefined || header.length !== 13)
		throw refuse('no IHDR chunk');
	const view = new DataView(header.buffer, header.byteOffset, 13);
	const width = view.getUint32(0);
	const height = view.getUint32(4);
	const depth = header[8];
	const colour = header[9];
	const interlace = header[12];
	if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) {
		throw refuse('the size is not valid');
	}
	if (maxPixels !== undefined && width * height > maxPixels) {
		throw new ImageError(
			'TOO_LARGE',
			'pixels',
			`the PNG has ${width}x${height} pixels, over the ${maxPixels} limit`,
		);
	}
	if (depth !== 8) throw refuse('only 8-bit samples are read');
	if (interlace !== 0) throw refuse('an interlaced PNG is not read');
	const samples = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour as 0 | 2 | 4 | 6];
	if (samples === undefined)
		throw refuse('this colour type (a palette, for one) is not read');

	const idat = chunks.filter((chunk) => chunk.type === 'IDAT');
	if (idat.length === 0) throw refuse('no IDAT chunk');
	// One IDAT (what Bun writes) is read in place: no second full-size copy.
	let compressed = idat[0]?.data as Uint8Array;
	if (idat.length > 1) {
		compressed = new Uint8Array(idat.reduce((n, c) => n + c.data.length, 0));
		let at = 0;
		for (const chunk of idat) {
			compressed.set(chunk.data, at);
			at += chunk.data.length;
		}
	}

	const expected = (width * samples + 1) * height;
	let raw: Uint8Array;
	try {
		// Bounded by the size the header promises: a bomb stops there.
		raw = inflateSync(compressed, { maxOutputLength: expected });
	} catch {
		throw refuse(
			'the pixel data is not valid zlib, or longer than the header says',
		);
	}
	if (raw.length !== expected)
		throw refuse('the pixel data is shorter than the header says');

	const flat = unfilter(raw, width, height, samples);
	if (!flat) throw refuse('a row has an unknown filter');
	return widen({ width, height, samples, flat });
}

/** Grey becomes RGB and grey with alpha becomes RGBA; RGB and RGBA pass. */
function widen(raw: {
	width: number;
	height: number;
	samples: number;
	flat: Uint8Array;
}): RawImage {
	const { width, height, samples, flat } = raw;
	if (samples >= 3) {
		return { width, height, channels: samples as 3 | 4, pixels: flat };
	}
	const channels = samples === 1 ? 3 : 4;
	const pixels = new Uint8Array(width * height * channels);
	for (let i = 0; i < width * height; i++) {
		const grey = flat[i * samples] as number;
		pixels.fill(grey, i * channels, i * channels + 3);
		if (channels === 4) pixels[i * 4 + 3] = flat[i * 2 + 1] as number;
	}
	return { width, height, channels, pixels };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(
		8 + data.length,
		Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0,
	);
	return out;
}

/**
 * A PNG of these pixels: IHDR, one IDAT (filter 0 on every row) and IEND,
 * with their CRCs, and nothing else, so no metadata can be in it.
 */
export function encodePng(image: RawImage): Uint8Array {
	const { width, height, channels, pixels } = image;
	const stride = width * channels;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw.set(
			pixels.subarray(y * stride, (y + 1) * stride),
			y * (stride + 1) + 1,
		);
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;
	header[9] = channels === 4 ? 6 : 2;
	const parts = [
		new Uint8Array(SIGNATURE),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', new Uint8Array(0)),
	];
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

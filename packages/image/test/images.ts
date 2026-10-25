import { deflateSync } from 'node:zlib';
import { cropPng } from '../src/crop/crop-png';
import { chunk, PNG_SIGNATURE, type RawImage } from '../src/crop/png';

/** A deterministic image whose rows and columns differ, so filters matter. */
export function pattern(
	width: number,
	height: number,
	channels: 3 | 4,
): RawImage {
	const pixels = new Uint8Array(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < channels; c++) {
				pixels[(y * width + x) * channels + c] =
					(x * 7 + y * 13 + c * 61 + ((x * y) & 31)) & 0xff;
			}
		}
	}
	return { width, height, channels, pixels };
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** An ISO-BMFF `ftyp` box: a major brand, a zero minor version, then the compatible brands. */
export function ftyp(major: string, compatible: string[]): Uint8Array {
	const brands = [major, '\0\0\0\0', ...compatible].join('');
	const out = new Uint8Array(8 + brands.length);
	new DataView(out.buffer).setUint32(0, out.length);
	out.set(new TextEncoder().encode(`ftyp${brands}`), 4);
	return out;
}

/** Forward PNG filters, written independently of the decoder under test. */
function filterRow(
	type: number,
	row: Uint8Array,
	above: Uint8Array | undefined,
	bpp: number,
): Uint8Array {
	const out = new Uint8Array(row.length);
	for (let i = 0; i < row.length; i++) {
		const a = i >= bpp ? (row[i - bpp] as number) : 0;
		const b = above ? (above[i] as number) : 0;
		const c = above && i >= bpp ? (above[i - bpp] as number) : 0;
		const p = a + b - c;
		const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
		const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
		const guess = [0, a, b, (a + b) >> 1, paeth][type] as number;
		out[i] = ((row[i] as number) - guess) & 0xff;
	}
	return out;
}

export type PngOptions = {
	/** The filter of each row, cycling; default 0. */
	filters?: number[];
	/** IHDR bit depth, colour type, interlace; default 8, from the channels, 0. */
	depth?: number;
	colour?: number;
	interlace?: number;
	/** Chunks written after IHDR, before IDAT. */
	extra?: Uint8Array[];
	/** The zlib bytes, in place of the real ones. */
	idat?: Uint8Array;
	/** Cut the file to this many bytes. */
	truncate?: number;
};

/** A PNG of `image`, as a configurable writer for decoder specs. */
export function writePng(
	image: RawImage,
	options: PngOptions = {},
): Uint8Array {
	const { width, height, channels, pixels } = image;
	const stride = width * channels;
	const filters = options.filters ?? [0];
	const rows: Uint8Array[] = [];
	for (let y = 0; y < height; y++) {
		const type = filters[y % filters.length] as number;
		const row = pixels.subarray(y * stride, (y + 1) * stride);
		const above =
			y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
		rows.push(new Uint8Array([type, ...filterRow(type, row, above, channels)]));
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = options.depth ?? 8;
	header[9] = options.colour ?? (channels === 4 ? 6 : 2);
	header[12] = options.interlace ?? 0;
	const file = concat([
		new Uint8Array(PNG_SIGNATURE),
		chunk('IHDR', header),
		...(options.extra ?? []),
		chunk('IDAT', options.idat ?? deflateSync(concat(rows))),
		chunk('IEND', new Uint8Array(0)),
	]);
	return options.truncate === undefined
		? file
		: file.subarray(0, options.truncate);
}

/**
 * Every pixel of a PNG, through the streaming crop reader (the reader the
 * package ships, which keeps only a region). Grey is widened, as it is there.
 */
export function decodePng(
	bytes: Uint8Array,
	maxPixels?: number,
): Promise<RawImage> {
	return cropPng(
		bytes,
		({ width, height }) => ({ x: 0, y: 0, width, height }),
		maxPixels,
	);
}

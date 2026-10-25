import { deflateSync } from 'node:zlib';
import { chunk, concat } from './images';

/**
 * Builders for inputs that carry metadata, and a reader for what a WebP
 * still holds. The segments are minimal but real: an EXIF block with an
 * Orientation tag and GPS tags, and an ICC profile header.
 */

function u16(value: number): number[] {
	return [value & 0xff, value >> 8];
}

function u32(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		(value >>> 24) & 0xff,
	];
}

function entry(tag: number, type: number, count: number, value: number[]) {
	const field = [...value, 0, 0, 0, 0].slice(0, 4);
	return [...u16(tag), ...u16(type), ...u32(count), ...field];
}

export type ExifOptions = {
	/** The EXIF Orientation tag, 1 to 8; left out when undefined. */
	orientation?: number;
	/** Add a GPS IFD with a latitude. */
	gps?: boolean;
};

/** The body of an EXIF block: a little-endian TIFF with IFD0 and, maybe, GPS. */
export function exifBody(options: ExifOptions = {}): Uint8Array {
	const ifd0: number[][] = [];
	if (options.orientation !== undefined) {
		ifd0.push(entry(0x0112, 3, 1, u16(options.orientation)));
	}
	const gpsAt = 8 + 2 + (ifd0.length + (options.gps ? 1 : 0)) * 12 + 4;
	if (options.gps) ifd0.push(entry(0x8825, 4, 1, u32(gpsAt)));
	const out: number[] = [0x49, 0x49, 0x2a, 0x00, ...u32(8)];
	out.push(...u16(ifd0.length), ...ifd0.flat(), ...u32(0));
	if (options.gps) {
		const dataAt = gpsAt + 2 + 2 * 12 + 4;
		out.push(
			...u16(2),
			...entry(0x0001, 2, 2, [0x4e, 0]),
			...entry(0x0002, 5, 3, u32(dataAt)),
			...u32(0),
		);
		for (const [numerator, denominator] of [
			[48, 1],
			[51, 1],
			[2940, 100],
		] as const) {
			out.push(...u32(numerator), ...u32(denominator));
		}
	}
	return new Uint8Array(out);
}

/** A 132-byte ICC profile: a valid header (`acsp`) and an empty tag table. */
export function iccProfile(): Uint8Array {
	const profile = new Uint8Array(132);
	const view = new DataView(profile.buffer);
	view.setUint32(0, 132);
	view.setUint32(8, 0x02100000);
	profile.set(
		[...'mntrRGB XYZ '].map((c) => c.charCodeAt(0)),
		12,
	);
	profile.set(
		[...'acsp'].map((c) => c.charCodeAt(0)),
		36,
	);
	return profile;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + payload.length);
	out.set([
		0xff,
		marker,
		(payload.length + 2) >> 8,
		(payload.length + 2) & 0xff,
	]);
	out.set(payload, 4);
	return out;
}

const ascii = (text: string) =>
	new Uint8Array([...text].map((c) => c.charCodeAt(0)));

/** The JPEG with an APP1 EXIF segment spliced in right after its SOI. */
export function withExif(jpeg: Uint8Array, options: ExifOptions): Uint8Array {
	const app1 = segment(0xe1, concat([ascii('Exif\0\0'), exifBody(options)]));
	return concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** The JPEG with an APP2 ICC_PROFILE segment spliced in after its SOI. */
export function withIcc(jpeg: Uint8Array): Uint8Array {
	const app2 = segment(
		0xe2,
		concat([ascii('ICC_PROFILE\0'), new Uint8Array([1, 1]), iccProfile()]),
	);
	return concat([jpeg.subarray(0, 2), app2, jpeg.subarray(2)]);
}

/** The PNG with an `iCCP` and an `eXIf` chunk spliced in before its IDAT. */
export function pngWithMetadata(png: Uint8Array): Uint8Array {
	const iccp = chunk(
		'iCCP',
		concat([ascii('test\0\0'), new Uint8Array(deflateSync(iccProfile()))]),
	);
	const exif = chunk('eXIf', exifBody({ orientation: 1, gps: true }));
	const at = png.indexOf(0x49, 33); // first 'I' after IHDR: the IDAT type
	const idat = at - 4;
	return concat([png.subarray(0, idat), iccp, exif, png.subarray(idat)]);
}

/** The FourCCs of a WebP's RIFF chunks, in order. */
export function webpChunks(bytes: Uint8Array): string[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const names: string[] = [];
	for (let at = 12; at + 8 <= bytes.length; ) {
		names.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
		const length = view.getUint32(at + 4, true);
		at += 8 + length + (length & 1);
	}
	return names;
}

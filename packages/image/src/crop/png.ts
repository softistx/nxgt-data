import { promisify } from 'node:util';
import { deflate } from 'node:zlib';

const deflateAsync = promisify(deflate);

/** Decoded pixels, row after row, `channels` bytes each: RGB or RGBA. */
export type RawImage = {
	width: number;
	height: number;
	channels: 3 | 4;
	pixels: Uint8Array;
};

/** The eight bytes every PNG starts with. */
export const PNG_SIGNATURE: readonly number[] = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** One PNG chunk: length, type, data and CRC. */
export function chunk(type: string, data: Uint8Array): Uint8Array {
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
 *
 * The deflate runs on zlib's thread pool, not the main thread: a large crop
 * stopped the event loop for 1.1 s synchronously (`[4096]` on 36 MP; 0.3 s
 * after). It costs memory, though: about 250 to 300 MB more at the `[4096]`
 * peak on 49 MP. It is level 1, since this PNG only lives for one pipeline
 * step (it is decoded again at once), so speed beats size.
 */
export async function encodePng(image: RawImage): Promise<Uint8Array> {
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
		new Uint8Array(PNG_SIGNATURE),
		chunk('IHDR', header),
		chunk('IDAT', await deflateAsync(raw, { level: 1 })),
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

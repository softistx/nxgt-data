import { ImageError } from '../errors/image-error';
import { PNG_SIGNATURE } from './png';

export function refuse(why: string): ImageError {
	return new ImageError(
		'UNDECODABLE',
		'decode',
		`the PNG cannot be read: ${why}`,
	);
}

/** What the header says, once it is checked against what this reader takes. */
export type PngHeader = {
	width: number;
	height: number;
	/** Samples per pixel as stored: 1 (grey), 2, 3 or 4. */
	samples: number;
};

/** The chunk at `at`: its type, a view of its data, and where the next starts. */
export function chunkAt(
	bytes: Uint8Array,
	at: number,
): { type: string; data: Uint8Array; next: number } {
	if (at + 12 > bytes.length) throw refuse('no IEND chunk');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = view.getUint32(at);
	if (at + 12 + length > bytes.length) throw refuse('a chunk is cut short');
	return {
		type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
		data: bytes.subarray(at + 8, at + 8 + length),
		next: at + 12 + length,
	};
}

/**
 * The signature and the header: 8-bit, not interlaced, grey, grey with
 * alpha, RGB or RGBA. `maxPixels` refuses a header that claims more, as
 * `TOO_LARGE` with the reason `pixels`, before anything is inflated.
 */
export function readHeader(bytes: Uint8Array, maxPixels?: number): PngHeader {
	if (!PNG_SIGNATURE.every((value, i) => bytes[i] === value)) {
		throw refuse('no PNG signature');
	}
	const first = chunkAt(bytes, 8);
	if (first.type !== 'IHDR' || first.data.length !== 13) {
		throw refuse('no IHDR chunk');
	}
	const header = first.data;
	const view = new DataView(header.buffer, header.byteOffset, 13);
	const width = view.getUint32(0);
	const height = view.getUint32(4);
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
	if (header[8] !== 8) throw refuse('only 8-bit samples are read');
	if (header[12] !== 0) throw refuse('an interlaced PNG is not read');
	const samples = { 0: 1, 2: 3, 4: 2, 6: 4 }[header[9] as 0 | 2 | 4 | 6];
	if (samples === undefined) {
		throw refuse('this colour type (a palette, for one) is not read');
	}
	return { width, height, samples };
}

/**
 * The zlib stream of the file as a stream of views of its IDAT payloads, read
 * lazily and never copied. A damaged chunk errors the stream with its
 * `ImageError`.
 */
export function idatStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let at = 8;
	let sawData = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			try {
				for (;;) {
					const found = chunkAt(bytes, at);
					at = found.next;
					if (found.type === 'IDAT') {
						sawData = true;
						controller.enqueue(found.data);
						return;
					}
					if (found.type === 'IEND') {
						if (!sawData) throw refuse('no IDAT chunk');
						controller.close();
						return;
					}
				}
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

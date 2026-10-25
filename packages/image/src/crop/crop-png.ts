import { ImageError } from '../errors/image-error';
import type { RawImage } from './png';
import { idatStream, type PngHeader, readHeader, refuse } from './png-chunks';
import { createRowAssembler } from './row-assembler';

/** A rectangle of pixels: `(x, y)` is its top-left corner. */
export type Region = { x: number; y: number; width: number; height: number };

function checkRegion(region: Region, header: PngHeader): void {
	const { x, y, width, height } = region;
	if (
		![x, y, width, height].every(Number.isInteger) ||
		x < 0 ||
		y < 0 ||
		width < 1 ||
		height < 1 ||
		x + width > header.width ||
		y + height > header.height
	) {
		throw new RangeError(
			`a ${width}x${height} region at (${x}, ${y}) does not fit a ${header.width}x${header.height} image`,
		);
	}
}

/** Copies columns of an unfiltered row into the output, widening grey. */
function copyColumns(
	row: Uint8Array,
	region: Region,
	samples: number,
	out: Uint8Array,
	outRow: number,
): void {
	const from = 1 + region.x * samples;
	if (samples >= 3) {
		out.set(row.subarray(from, from + region.width * samples), outRow);
		return;
	}
	const channels = samples === 1 ? 3 : 4;
	for (let i = 0; i < region.width; i++) {
		const grey = row[from + i * samples] as number;
		const at = outRow + i * channels;
		out[at] = grey;
		out[at + 1] = grey;
		out[at + 2] = grey;
		if (channels === 4) out[at + 3] = row[from + i * samples + 1] as number;
	}
}

/**
 * Reads a region of what `Bun.Image(...).png()` emits (8-bit, not
 * interlaced, grey, grey with alpha, RGB or RGBA, any of the five filters)
 * while the PNG inflates, and stops after the region's last row. Grey is
 * widened to RGB, grey with alpha to RGBA. Only two rows (the one above and
 * the current one) are ever held, plus the region's own pixels, and the
 * IDAT payloads are read in place, so the cost does not grow with the image.
 * Every other chunk (colour profile, EXIF, text) is read past and dropped,
 * which is how a re-encode strips them.
 *
 * The input is Bun's own PNG, never the user's bytes, so the rest of the file
 * is trusted once the region is read: a cut file, a missing IEND, a bad CRC
 * or a bad zlib checksum after the region's last row is **not seen**. Only a
 * region that reaches the image's last row reads on to the end of the zlib
 * stream, checking its checksum and that no data is left over.
 *
 * `region` is a rectangle, or a function of the header's size, for a caller
 * that knows the region only once it knows the size. `maxPixels` refuses a
 * PNG whose header claims more pixels, before anything is inflated:
 * `TOO_LARGE` with the reason `pixels`. Inflated data longer than the header
 * promises is refused, as far as the stream is read.
 *
 * `onCancel` is called when the read stops before the end of the IDAT data
 * (the region's last row is not the image's), after the stream is cancelled;
 * it exists so a spec can see that the stream is released.
 */
export async function cropPng(
	bytes: Uint8Array,
	region: Region | ((size: { width: number; height: number }) => Region),
	maxPixels?: number,
	onCancel?: () => void,
): Promise<RawImage> {
	const header = readHeader(bytes, maxPixels);
	const wanted = typeof region === 'function' ? region(header) : region;
	checkRegion(wanted, header);
	const { width, height, samples } = header;
	const channels = samples === 1 || samples === 3 ? 3 : 4;
	const lastRow = wanted.y + wanted.height - 1;
	const out = new Uint8Array(wanted.width * wanted.height * channels);

	const rows = createRowAssembler(
		width * samples,
		height,
		samples,
		(row, y) => {
			if (y >= wanted.y) {
				const outRow = (y - wanted.y) * wanted.width * channels;
				copyColumns(row, wanted, samples, out, outRow);
			}
			// Past the region's last row there is nothing left to read, unless it is
			// the last row of the image: then the rest is checked.
			return y < lastRow || lastRow === height - 1;
		},
	);
	const inflate = new DecompressionStream('deflate') as unknown as {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	};
	const reader = idatStream(bytes, onCancel).pipeThrough(inflate).getReader();
	try {
		for (;;) {
			let part: Awaited<ReturnType<typeof reader.read>>;
			try {
				part = await reader.read();
			} catch (error) {
				if (error instanceof ImageError) throw error;
				throw refuse('the pixel data is not valid zlib');
			}
			if (part.done) {
				if (rows.rows < height) {
					throw refuse('the pixel data is shorter than the header says');
				}
				break;
			}
			if (!rows.feed(part.value)) break;
		}
		return {
			width: wanted.width,
			height: wanted.height,
			channels,
			pixels: out,
		};
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

import type { RawImage } from '../src/crop/png';
import { decodePng } from './images';

/**
 * A scene of flat coloured blocks, 100 px each, four columns by two rows, so
 * a crop can be proven by the colour it lands on. Flat blocks survive the
 * lossy WebP: a sample taken well inside a block is within a few levels.
 */
export const PALETTE: readonly (readonly [number, number, number])[][] = [
	[
		[255, 0, 0],
		[0, 200, 0],
		[0, 0, 255],
		[255, 255, 0],
	],
	[
		[255, 0, 255],
		[0, 255, 255],
		[255, 255, 255],
		[0, 0, 0],
	],
];

/** `columns` × `rows` blocks of 100 px, RGB or RGBA (opaque). */
export function scene(columns = 4, rows = 2, channels: 3 | 4 = 3): RawImage {
	const width = columns * 100;
	const height = rows * 100;
	const pixels = new Uint8Array(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const colour = PALETTE[Math.floor(y / 100)]?.[Math.floor(x / 100)];
			for (let c = 0; c < channels; c++) {
				pixels[(y * width + x) * channels + c] =
					c < 3 ? (colour?.[c] as number) : 255;
			}
		}
	}
	return { width, height, channels, pixels };
}

/** The pixels of an image Bun can read, through `Bun.Image(...).png()`. */
export async function pixelsOf(bytes: Uint8Array): Promise<RawImage> {
	return decodePng(await new Bun.Image(bytes).png().bytes());
}

/** The RGBA at a fraction of the image, e.g. `(0.25, 0.75)`. */
export function sample(
	image: RawImage,
	fx: number,
	fy: number,
): [number, number, number, number] {
	const x = Math.floor(image.width * fx);
	const y = Math.floor(image.height * fy);
	const at = (y * image.width + x) * image.channels;
	return [
		image.pixels[at] as number,
		image.pixels[at + 1] as number,
		image.pixels[at + 2] as number,
		image.channels === 4 ? (image.pixels[at + 3] as number) : 255,
	];
}

/** Whether the RGB of a sample is within `tolerance` of the colour. */
export function isNear(
	got: readonly number[],
	want: readonly number[],
	tolerance = 40,
): boolean {
	return want.every(
		(value, i) => Math.abs((got[i] as number) - value) <= tolerance,
	);
}

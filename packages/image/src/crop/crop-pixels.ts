import type { RawImage } from './png';

/**
 * The square of `size` pixels whose top-left corner is `(x, y)`. The caller
 * has already chosen a square that fits; a square that does not is a
 * `RangeError`, since it can only be a bug.
 */
export function cropPixels(
	image: RawImage,
	square: { x: number; y: number; size: number },
): RawImage {
	const { x, y, size } = square;
	const { width, height, channels, pixels } = image;
	if (
		![x, y, size].every(Number.isInteger) ||
		x < 0 ||
		y < 0 ||
		size < 1 ||
		x + size > width ||
		y + size > height
	) {
		throw new RangeError(
			`a ${size}px square at (${x}, ${y}) does not fit a ${width}x${height} image`,
		);
	}
	const row = size * channels;
	const out = new Uint8Array(row * size);
	for (let line = 0; line < size; line++) {
		const from = ((y + line) * width + x) * channels;
		out.set(pixels.subarray(from, from + row), line * row);
	}
	return { width: size, height: size, channels, pixels: out };
}

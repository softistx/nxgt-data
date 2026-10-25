import type { CropBox } from '../set/types';
import { isWhole } from '../set/whole';

/** The size of an image, in pixels. */
export type Dimensions = { width: number; height: number };

/**
 * How much to shrink before cropping: enough that the crop keeps twice the
 * largest variant (so the last resize still has pixels to average), never
 * more than 1, since a source is never enlarged.
 */
export function shrinkScale(cropSide: number, largestSize: number): number {
	return Math.min(1, (2 * largestSize) / cropSide);
}

/** The size the shrunk image has: at least one pixel on each side. */
export function scaledDimensions(
	{ width, height }: Dimensions,
	scale: number,
): Dimensions {
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** The square of side `min(width, height)` in the middle of the image. */
export function centredCrop({ width, height }: Dimensions): CropBox {
	const size = Math.min(width, height);
	return {
		x: Math.floor((width - size) / 2),
		y: Math.floor((height - size) / 2),
		size,
	};
}

/**
 * Refuses a crop that is not three whole non-negative numbers. The caller
 * wrote it, so it is a `RangeError`, not an upload refusal.
 */
export function assertCropShape(crop: CropBox): void {
	if (![crop.x, crop.y, crop.size].every((value) => isWhole(value))) {
		throw new RangeError(
			'a crop is { x, y, size }, three whole numbers of 0 or more',
		);
	}
}

/** Refuses a crop that is not inside the (oriented) image. */
export function assertCropFits(crop: CropBox, image: Dimensions): void {
	if (
		crop.size < 1 ||
		crop.x + crop.size > image.width ||
		crop.y + crop.size > image.height
	) {
		throw new RangeError(
			`a ${crop.size}px crop at (${crop.x}, ${crop.y}) does not fit the ${image.width}x${image.height} image`,
		);
	}
}

/**
 * The crop in the shrunk image's pixels: each number rounded, then clamped so
 * the square stays inside it (rounding can overshoot an edge by a pixel).
 */
export function scaleCrop(
	crop: CropBox,
	scale: number,
	shrunk: Dimensions,
): CropBox {
	const size = Math.max(
		1,
		Math.min(Math.round(crop.size * scale), shrunk.width, shrunk.height),
	);
	const clamp = (value: number, room: number) =>
		Math.max(0, Math.min(Math.round(value * scale), room - size));
	return {
		x: clamp(crop.x, shrunk.width),
		y: clamp(crop.y, shrunk.height),
		size,
	};
}

import type { ImageInput } from '../input/read-input';
import type { SniffedFormat } from '../input/sniff';

/**
 * A square to keep, in pixels of the **auto-oriented** image: the picture as
 * a person sees it, after EXIF rotation. `(x, y)` is its top-left corner.
 *
 * Only a JPEG's EXIF orientation is applied (measured on Bun 1.4.3): the
 * orientation of a PNG (`eXIf`) or of a WebP (`EXIF`) is ignored, so for those
 * the frame is the stored one.
 */
export type CropBox = { x: number; y: number; size: number };

export type ProcessOptions = {
	/** The square to keep. Default: the centred square of the short side. */
	crop?: CropBox;
};

/** One output: a square WebP. */
export type ImageVariant = {
	/** The side asked for in `sizes`; `width` and `height` equal it. */
	size: number;
	width: number;
	height: number;
	contentType: 'image/webp';
	bytes: Uint8Array;
};

export type ProcessedImage = {
	/** The upload as read: its format and its oriented size. */
	source: { format: SniffedFormat; width: number; height: number };
	/** One per size, in the order of `sizes`. */
	variants: ImageVariant[];
};

export type ImageSet = {
	/** The sides this set produces, in the order of `process`'s variants. */
	readonly sizes: readonly number[];
	/**
	 * Checks, crops, resizes and re-encodes an upload to WebP, with every
	 * metadata stripped. Refusals are `ImageError`; a `crop` that is not
	 * whole numbers or does not fit the image is an `ImageError` (`INVALID_CROP`).
	 */
	process(input: ImageInput, options?: ProcessOptions): Promise<ProcessedImage>;
};

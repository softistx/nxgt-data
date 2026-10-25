import { isWhole } from './whole';

/** What `defineImageSet` takes; every field has a default. */
export type ImageSetOptions = {
	/**
	 * The square sides to produce, in pixels: a non-empty list of unique whole
	 * numbers from 1 to 4096. Default `[256, 64]`.
	 */
	sizes?: readonly number[];
	/** The upload's byte limit, a whole number of 1 or more. Default 5 MiB. */
	maxBytes?: number;
	/**
	 * The most pixels (width × height) an upload may claim, a whole number of
	 * 1 or more. Default 50 000 000, which covers a 48 MP phone.
	 *
	 * **Memory:** a call decodes the whole image once, in `Bun.Image`, which
	 * holds about 4 bytes per pixel (RGBA) while it re-encodes; the crop is then
	 * read out of that PNG as it inflates, two rows at a time, so nothing else
	 * of that size is kept. Measured on Bun 1.4.3, one call grows the process by
	 * about 150 MB for a 36 MP JPEG and about 200 MB for a 49 MP one. Plan on
	 * 4.5 bytes per pixel: about 225 MB per call at the default `maxPixels`, and
	 * a ceiling of `concurrency × 4.5 × maxPixels` bytes (450 MB at the defaults),
	 * the bytes of the uploads waiting apart (see `concurrency`).
	 */
	maxPixels?: number;
	/**
	 * The smallest side an upload, or a crop of it, may have. Default: the
	 * largest of `sizes`, so no variant is ever enlarged.
	 */
	minSide?: number;
	/** The WebP quality, 1 to 100. Default 80. */
	quality?: number;
	/**
	 * How many `process` calls of this set decode at once, a whole number from
	 * 1 to 64. Default 2. The others wait their turn, in order, after their
	 * bytes are read and their format sniffed; this bounds the memory (see
	 * `maxPixels`). Measured on a 36 MP JPEG, 4 calls at once grew the process
	 * by about 300 MB with the default 2 and about 150 MB with 1.
	 *
	 * **The wait queue is not bounded**, and each waiting call holds its
	 * upload's bytes (up to `maxBytes`). A server that can receive more uploads
	 * than it decodes should cap them before they reach `process`.
	 */
	concurrency?: number;
};

/** The options with every default applied. */
export type ResolvedOptions = {
	readonly sizes: readonly number[];
	readonly maxBytes: number;
	readonly maxPixels: number;
	readonly minSide: number;
	readonly quality: number;
	readonly concurrency: number;
};

const DEFAULT_SIZES: readonly number[] = [256, 64];
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 50_000_000;
const DEFAULT_QUALITY = 80;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 64;
const MAX_SIZE = 4096;

function whole(name: string, value: unknown, min: number, max?: number) {
	if (!isWhole(value, min, max)) {
		const range = max === undefined ? `${min} or more` : `${min} to ${max}`;
		throw new TypeError(
			`${name} must be a whole number of ${range}, got ${String(value)}`,
		);
	}
	return value;
}

function checkSizes(sizes: unknown): readonly number[] {
	if (!Array.isArray(sizes) || sizes.length === 0) {
		throw new TypeError('sizes must be a non-empty array of whole numbers');
	}
	for (const size of sizes) whole('sizes[]', size, 1, MAX_SIZE);
	if (new Set(sizes).size !== sizes.length) {
		throw new TypeError(`sizes must be unique, got [${sizes.join(', ')}]`);
	}
	return Object.freeze([...sizes]);
}

/** The options with their defaults, or a `TypeError` naming the bad one. */
export function resolveOptions(options: ImageSetOptions = {}): ResolvedOptions {
	const sizes = checkSizes(options.sizes ?? DEFAULT_SIZES);
	return Object.freeze({
		sizes,
		maxBytes: whole('maxBytes', options.maxBytes ?? DEFAULT_MAX_BYTES, 1),
		maxPixels: whole('maxPixels', options.maxPixels ?? DEFAULT_MAX_PIXELS, 1),
		minSide: whole('minSide', options.minSide ?? Math.max(...sizes), 1),
		quality: whole('quality', options.quality ?? DEFAULT_QUALITY, 1, 100),
		concurrency: whole(
			'concurrency',
			options.concurrency ?? DEFAULT_CONCURRENCY,
			1,
			MAX_CONCURRENCY,
		),
	});
}

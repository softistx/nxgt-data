import { isWhole } from './whole';

/** What `defineImageSet` takes; every field has a default. */
export type ImageSetOptions = {
	/**
	 * The square sides to produce, in pixels: a non-empty list of unique whole
	 * numbers from 1 to 4096. Default `[256, 64]`.
	 */
	sizes?: readonly number[];
	/**
	 * The upload's byte limit, a whole number of 1 or more. Default 5 MiB,
	 * which admits most 12 MP photos but refuses most 48 MP phone JPEGs (about
	 * 11 MB). Raise it with `maxPixels`: `maxBytes: 12 * 1024 * 1024`.
	 */
	maxBytes?: number;
	/**
	 * The most pixels (width × height) an upload may claim, a whole number of
	 * 1 or more. Default 25 000 000, which covers a 24 MP phone's output. A
	 * 48 MP image is admitted only by raising this, and its JPEG (about 11 MB)
	 * is refused by the default `maxBytes` first: raise both.
	 *
	 * **Memory.** One call peaks at about Bun's decode of the source (4 bytes
	 * per pixel) + the intermediate PNG + the crop square, about
	 * 4 × (2 × the largest size)² bytes. A centred crop with the default sizes
	 * is cheap (about 17 MB measured, at 12 to 49 MP). The expensive path is a
	 * small caller `crop` on a big image, or large `sizes`. Measured on
	 * Bun 1.4.3, photo-like JPEGs, one call: a 256 px crop on 25 MP grows the
	 * process by about 150 MB (2.7 s), on 36 MP about 210 MB (4 s), on 49 MP
	 * about 280 MB (5.4 s); `sizes: [4096]` on 49 MP about 940 MB (8 s).
	 *
	 * **Bun 1.4.3 holds on to each `png()` output** (about the size of that
	 * PNG per call) until a later collection, so sequential worst-case calls
	 * climb before the memory falls back: 70 calls with a small crop climbed to
	 * about 720 MB at 25 MP and to over 1.6 GB at 36 MP. Lowering `maxPixels`
	 * is the lever that shrinks both.
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
	 * bytes are read and their format sniffed. It limits the calls in flight,
	 * **not the memory**: Bun holds each `png()` output until a later
	 * collection (see `maxPixels`), so memory can pass `concurrency` × one
	 * call's peak. Measured on a 36 MP JPEG with a small crop, 4 calls at once
	 * grew the process by about 770 MB with `concurrency` 4, 510 MB with 2 and
	 * 330 MB with 1.
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
const DEFAULT_MAX_PIXELS = 25_000_000;
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

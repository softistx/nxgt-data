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
	 */
	maxPixels?: number;
	/**
	 * The smallest side an upload, or a crop of it, may have. Default: the
	 * largest of `sizes`, so no variant is ever enlarged.
	 */
	minSide?: number;
	/** The WebP quality, 1 to 100. Default 80. */
	quality?: number;
};

/** The options with every default applied. */
export type ResolvedOptions = {
	readonly sizes: readonly number[];
	readonly maxBytes: number;
	readonly maxPixels: number;
	readonly minSide: number;
	readonly quality: number;
};

export const DEFAULT_SIZES: readonly number[] = [256, 64];
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_PIXELS = 50_000_000;
export const DEFAULT_QUALITY = 80;
export const MAX_SIZE = 4096;

function whole(name: string, value: unknown, min: number, max?: number) {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < min ||
		(max !== undefined && value > max)
	) {
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
	});
}

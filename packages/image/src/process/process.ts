import { cropPng } from '../crop/crop-png';
import { encodePng } from '../crop/png';
import { ImageError } from '../errors/image-error';
import { type ImageInput, readInput } from '../input/read-input';
import { type SniffedFormat, sniffFormat } from '../input/sniff';
import type { ResolvedOptions } from '../set/options';
import type {
	CropBox,
	ImageVariant,
	ProcessedImage,
	ProcessOptions,
} from '../set/types';
import { mapBunError } from './bun-errors';
import {
	assertCropFits,
	assertCropShape,
	centredCrop,
	type Dimensions,
	scaleCrop,
	scaledDimensions,
	shrinkScale,
} from './geometry';

/** Runs a Bun pipeline step, its refusals turned into `ImageError`. */
async function guarded<T>(
	format: SniffedFormat,
	step: () => Promise<T>,
): Promise<T> {
	try {
		return await step();
	} catch (error) {
		throw mapBunError(error, format);
	}
}

/** The oriented size: `metadata()` reports it after EXIF rotation (measured). */
async function readDimensions(
	bytes: Uint8Array,
	format: SniffedFormat,
	maxPixels: number,
): Promise<Dimensions> {
	const { width, height } = await guarded(format, () =>
		new Bun.Image(bytes, { maxPixels, autoOrient: true }).metadata(),
	);
	return { width, height };
}

/**
 * The image shrunk once, as a PNG at Bun's default level. That level gives
 * the smallest PNG, and Bun 1.4.3 holds each `png()` output until a later
 * collection, so the smallest PNG is the least memory held: a 36 MP photo
 * gave a 45 MB PNG at the default level and 146 MB at level 0, and a process
 * grew by about the PNG's size per call (measured). Level 0 is faster, but
 * its bigger output is what stays. Even so, sequential calls with a small
 * crop climb before the memory falls back (see `maxPixels`).
 */
function shrink(
	bytes: Uint8Array,
	format: SniffedFormat,
	image: Dimensions,
	scale: number,
	maxPixels: number,
): Promise<Uint8Array> {
	return guarded(format, () => {
		let pipeline = new Bun.Image(bytes, { maxPixels, autoOrient: true });
		if (scale < 1) {
			const to = scaledDimensions(image, scale);
			pipeline = pipeline.resize(to.width, to.height, { fit: 'fill' });
		}
		return pipeline.png().bytes();
	});
}

function variantOf(
	square: Uint8Array,
	size: number,
	quality: number,
): Promise<ImageVariant> {
	return guarded('png', () =>
		new Bun.Image(square)
			.resize(size, size, { fit: 'fill' })
			.webp({ quality })
			.bytes(),
	).then((bytes) => ({
		size,
		width: size,
		height: size,
		contentType: 'image/webp' as const,
		bytes,
	}));
}

/**
 * The crop as a PNG. The shrunk PNG is read while it inflates, keeping two
 * rows and the crop, so the full-size pixels are never held (see
 * `cropPng`); only the PNG bytes and the crop are live together.
 */
async function cropToPng(
	bytes: Uint8Array,
	format: SniffedFormat,
	image: Dimensions,
	box: CropBox,
	options: ResolvedOptions,
): Promise<Uint8Array> {
	const scale = shrinkScale(box.size, Math.max(...options.sizes));
	const square = await cropPng(
		await shrink(bytes, format, image, scale, options.maxPixels),
		(shrunk) => {
			const { x, y, size } = scaleCrop(box, scale, shrunk);
			return { x, y, width: size, height: size };
		},
		options.maxPixels,
	);
	return await encodePng(square);
}

/** The pipeline behind `ImageSet.process`; the steps are in docs/guide/processing.md. */
export async function processImage(
	input: ImageInput,
	{ crop }: ProcessOptions,
	options: ResolvedOptions,
	limit: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<ProcessedImage> {
	const bytes = await readInput(input, options.maxBytes);
	const format = sniffFormat(bytes);
	if (format === undefined) {
		throw new ImageError(
			'UNSUPPORTED_TYPE',
			'format',
			'the upload is not a JPEG, PNG, WebP or HEIC',
		);
	}
	// From here on the call decodes pixels: `concurrency` of them at a time.
	return limit(async () => {
		const image = await readDimensions(bytes, format, options.maxPixels);

		if (crop !== undefined) {
			assertCropShape(crop);
			assertCropFits(crop, image);
		}
		const box = crop ?? centredCrop(image);
		if (box.size < options.minSide) {
			throw new ImageError(
				'TOO_SMALL',
				'dimensions',
				crop
					? `the crop is ${crop.size}px, under the ${options.minSide}px minimum`
					: `the image is ${image.width}x${image.height}, under ${options.minSide}px on its short side`,
			);
		}

		const squarePng = await cropToPng(bytes, format, image, box, options);
		const variants = await Promise.all(
			options.sizes.map((size) => variantOf(squarePng, size, options.quality)),
		);
		return { source: { format, ...image }, variants };
	});
}

import { cropPixels } from '../crop/crop-pixels';
import { decodePng, encodePng } from '../crop/png';
import { ImageError } from '../errors/image-error';
import { type ImageInput, readInput } from '../input/read-input';
import { type SniffedFormat, sniffFormat } from '../input/sniff';
import type { ResolvedOptions } from '../set/options';
import type {
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
		new Bun.Image(bytes, { maxPixels }).metadata(),
	);
	return { width, height };
}

/**
 * The image shrunk once, as an uncompressed PNG: level 0 measured faster
 * overall than the default (the decode that follows is cheaper too).
 */
function shrink(
	bytes: Uint8Array,
	format: SniffedFormat,
	image: Dimensions,
	scale: number,
	maxPixels: number,
): Promise<Uint8Array> {
	return guarded(format, () => {
		let pipeline = new Bun.Image(bytes, { maxPixels });
		if (scale < 1) {
			const to = scaledDimensions(image, scale);
			pipeline = pipeline.resize(to.width, to.height, { fit: 'fill' });
		}
		return pipeline.png({ compressionLevel: 0 }).bytes();
	});
}

function variantOf(
	cropPng: Uint8Array,
	size: number,
	quality: number,
): Promise<ImageVariant> {
	return new Bun.Image(cropPng)
		.resize(size, size, { fit: 'fill' })
		.webp({ quality })
		.bytes()
		.then((bytes) => ({
			size,
			width: size,
			height: size,
			contentType: 'image/webp' as const,
			bytes,
		}));
}

/** The pipeline behind `ImageSet.process`; see the README for the steps. */
export async function processImage(
	input: ImageInput,
	{ crop }: ProcessOptions,
	options: ResolvedOptions,
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
	const image = await readDimensions(bytes, format, options.maxPixels);

	if (crop !== undefined) assertCropShape(crop);
	const box = crop ?? centredCrop(image);
	if (
		(crop ? crop.size : Math.min(image.width, image.height)) < options.minSide
	) {
		throw new ImageError(
			'TOO_SMALL',
			'dimensions',
			crop
				? `the crop is ${crop.size}px, under the ${options.minSide}px minimum`
				: `the image is ${image.width}x${image.height}, under ${options.minSide}px on its short side`,
		);
	}
	if (crop !== undefined) assertCropFits(crop, image);

	const scale = shrinkScale(box.size, Math.max(...options.sizes));
	const shrunkPng = await shrink(
		bytes,
		format,
		image,
		scale,
		options.maxPixels,
	);
	const shrunk = decodePng(shrunkPng, options.maxPixels);
	const cropPng = encodePng(cropPixels(shrunk, scaleCrop(box, scale, shrunk)));

	const variants = await Promise.all(
		options.sizes.map((size) => variantOf(cropPng, size, options.quality)),
	);
	return { source: { format, ...image }, variants };
}

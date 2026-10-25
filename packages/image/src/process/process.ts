import { cropPixels } from '../crop/crop-pixels';
import { decodePng, encodePng, type RawImage } from '../crop/png';
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
	return guarded('png', () =>
		new Bun.Image(cropPng)
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
 * The crop as a PNG. Each full-size buffer is dropped as soon as the next
 * step has what it needs (the shrunk PNG once decoded, the decoded image
 * once cropped), so one of them is live at a time.
 */
async function cropToPng(
	bytes: Uint8Array,
	format: SniffedFormat,
	image: Dimensions,
	box: CropBox,
	options: ResolvedOptions,
): Promise<Uint8Array> {
	const scale = shrinkScale(box.size, Math.max(...options.sizes));
	let shrunk: RawImage | undefined = decodePng(
		await shrink(bytes, format, image, scale, options.maxPixels),
		options.maxPixels,
	);
	const square = cropPixels(shrunk, scaleCrop(box, scale, shrunk));
	shrunk = undefined;
	return encodePng(square);
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

		const cropPng = await cropToPng(bytes, format, image, box, options);
		const variants = await Promise.all(
			options.sizes.map((size) => variantOf(cropPng, size, options.quality)),
		);
		return { source: { format, ...image }, variants };
	});
}

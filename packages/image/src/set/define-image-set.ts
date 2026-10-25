import { processImage } from '../process/process';
import { createLimit } from './limit';
import { type ImageSetOptions, resolveOptions } from './options';
import type { ImageSet } from './types';

/**
 * An image set: what to make of an upload, defined once.
 *
 * ```ts
 * const avatars = defineImageSet({ sizes: [256, 64] });
 * const { variants } = await avatars.process(await request.blob());
 * ```
 *
 * Invalid options throw a `TypeError` here, naming the option.
 */
export function defineImageSet(options: ImageSetOptions = {}): ImageSet {
	const resolved = resolveOptions(options);
	const limit = createLimit(resolved.concurrency);
	return {
		process: (input, processOptions = {}) =>
			processImage(input, processOptions, resolved, limit),
	};
}

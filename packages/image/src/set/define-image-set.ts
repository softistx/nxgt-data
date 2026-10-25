import { processImage } from '../process/process';
import { createLimit } from './limit';
import { type ImageSetOptions, resolveOptions } from './options';
import { assertBunImage } from './runtime';
import type { ImageSet } from './types';

/**
 * An image set: what to make of an upload, defined once.
 *
 * ```ts
 * const avatars = defineImageSet({ sizes: [256, 64] });
 * const { variants } = await avatars.process(await request.blob());
 * ```
 *
 * Throws a `TypeError` on a Bun older than 1.4.1, where `Bun.Image` is missing.
 * Invalid options throw a `TypeError` here, naming the option.
 */
export function defineImageSet(options: ImageSetOptions = {}): ImageSet {
	assertBunImage(typeof Bun === 'undefined' ? undefined : Bun);
	const resolved = resolveOptions(options);
	const limit = createLimit(resolved.concurrency);
	return {
		sizes: resolved.sizes,
		process: (input, processOptions = {}) =>
			processImage(input, processOptions, resolved, limit),
	};
}

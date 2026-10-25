/**
 * Throws a clear `TypeError` when the runtime has no `Bun.Image` (Bun older
 * than 1.4.1, or not Bun at all). Takes the `Bun` global as an argument so it
 * can be tested without touching the real one.
 */
export function assertBunImage(bun: unknown): void {
	if (
		typeof bun === 'undefined' ||
		bun === null ||
		typeof (bun as { Image?: unknown }).Image !== 'function'
	) {
		throw new TypeError(
			'@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists',
		);
	}
}

/**
 * The rejection a promise ends in, taken where the promise is made: the
 * resolved arm throws, and `expect(await rejection(p))` asserts on the error.
 *
 * Not `expect(p).rejects` held across an `await`: measured on bun 1.4.2, that
 * never returns, and the whole file runs out of time.
 */
export function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(error: unknown) => error,
	);
}

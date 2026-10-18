/**
 * The wait before retry number `attempt` (counting from 1): a random span
 * below `base * 2^(attempt - 1)`, capped at `max`. The jitter is the whole
 * span ("full jitter"), so workers that failed together do not retry together.
 *
 * @param random - a `Math.random`, replaceable in a test.
 */
export function backoffDelay(
	attempt: number,
	backoff: { readonly base: number; readonly max: number },
	random: () => number = Math.random,
): number {
	return Math.floor(
		random() * Math.min(backoff.max, backoff.base * 2 ** (attempt - 1)),
	);
}

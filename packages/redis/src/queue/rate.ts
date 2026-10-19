import { checkRateValues } from '../rate-limit/define-rate-limit';
import { toMs } from './duration';
import type { QueueRate, QueueRateLimit } from './flow-types';

/**
 * Checks a queue's `rateLimit` with the numeric rules of `defineRateLimit`,
 * and resolves it: frozen, `per` in milliseconds, `burst` defaulting to
 * `limit`. `undefined` stays `undefined`.
 *
 * @throws TypeError for a value that could never work, named after `call`
 * and the queue.
 */
export function resolveRateLimit(
	value: QueueRateLimit | undefined,
	call: string,
	name: string,
): QueueRate | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'object' || value === null) {
		throw new TypeError(
			`${call}: "${name}" has a rateLimit that is not an object; it is { limit, per, burst? }`,
		);
	}
	const { limit, burst } = value;
	const per = toMs(value.per, `${call}: "${name}" rateLimit per`);
	checkRateValues(call, `"${name}" rateLimit`, limit, per, burst);
	return Object.freeze({ limit, per, burst: burst ?? limit });
}

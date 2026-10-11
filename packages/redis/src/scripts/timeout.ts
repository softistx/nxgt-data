import { GuardError } from '../errors/guard-error';

/**
 * Checks a `timeoutMs` before anything is sent. A bare `TypeError`, like
 * `wait`'s: a timeout is the code's, not a request's. Its message quotes no
 * value all the same.
 */
export function checkTimeout(
	call: string,
	name: string,
	timeoutMs: unknown,
): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (
		typeof timeoutMs !== 'number' ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1
	) {
		throw new TypeError(
			`${call} on "${name}": timeoutMs is a whole number of milliseconds, 1 or more`,
		);
	}
	return timeoutMs;
}

/**
 * The `TIMEOUT` a guard throws when Redis did not answer in time. It names
 * the definition, never the key, and says what may still happen: the script
 * was sent, and the server runs it whenever it gets to it.
 */
export function timedOut(
	call: string,
	name: string,
	timeoutMs: number,
	consequence: string,
): GuardError {
	return new GuardError(
		'TIMEOUT',
		name,
		`${call} on "${name}": Redis did not answer within ${timeoutMs}ms; ${consequence}`,
	);
}

/**
 * Waits for `pending` at most `timeoutMs`, then rejects with what `onTimeout`
 * builds. Without a timeout it is `pending` itself.
 *
 * The command is not withdrawn — Bun's client has no way to — so its answer
 * may still arrive; `Promise.race` holds it, so a late rejection is never an
 * unhandled one. The timer is cleared whichever way it ends, so none outlives
 * the call.
 */
export async function withinTimeout<T>(
	pending: Promise<T>,
	timeoutMs: number | undefined,
	onTimeout: (timeoutMs: number) => GuardError,
): Promise<T> {
	if (timeoutMs === undefined) return await pending;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout(timeoutMs)), timeoutMs);
	});
	try {
		return await Promise.race([pending, expired]);
	} finally {
		clearTimeout(timer);
	}
}

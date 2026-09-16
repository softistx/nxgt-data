import type { ChangeOptions } from './change-types';

/**
 * Server errors a new stream would only meet again: the caller's own input
 * (2 BadValue, 9 FailedToParse, 14 TypeMismatch, 40647 — a bad filter or
 * token, measured), a history the server no longer has (280, 286), a user who
 * may not read (13, 18). Everything else the driver gave up on is worth
 * another try from the last token — measured, without the resumable label the
 * driver gives up even on 91 ShutdownInProgress, and closes its stream with
 * its token intact.
 */
const FATAL = new Set([2, 9, 13, 14, 18, 280, 286, 40647]);

/**
 * Whether the error is the driver's own refusal — a closed client, a bad
 * argument. Each has a name of its own, so the chain is walked; by name
 * rather than `instanceof`, which two copies of the driver defeat.
 */
function isApiError(error: object): boolean {
	for (let at = error; at; at = Object.getPrototypeOf(at)) {
		if (at.constructor?.name === 'MongoAPIError') return true;
	}
	return false;
}

export function worthRetrying(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { name, code } = error as { name?: unknown; code?: unknown };
	if (typeof name !== 'string' || !name.startsWith('Mongo')) return false;
	if (isApiError(error)) return false;
	return typeof code !== 'number' || !FATAL.has(code);
}

export /** Waits before another attempt, or less if the subscription is closed. */
function pause(attempt: number, signal: AbortSignal): Promise<void> {
	const ms = Math.min(100 * 2 ** (attempt - 1), 10_000);
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export function retriesOf(options: ChangeOptions<never>): number {
	const retries = options.retries ?? 5;
	if (!Number.isInteger(retries) || retries < 0) {
		throw new TypeError(
			`onChange: retries must be a whole number of at least 0, not ${String(retries)}`,
		);
	}
	return retries;
}

import type { RedisClient } from 'bun';
import { type Begun, begin } from '../scripts';

/** The first pause between two polls of a running key, in milliseconds. */
export const FIRST_POLL = 25;

/**
 * The longest pause between two polls. A running key's `retryAfter` is when
 * its lease lapses **unless renewed** — about the whole lease, since a live
 * run renews it every third — so sleeping that long would notice a finished
 * run up to a lease late. Polls start at `FIRST_POLL` and double up to this.
 */
export const LAST_POLL = 250;

/**
 * Checks a `wait` before anything is sent. A bare `TypeError`, like a
 * definition's refusals: a wait is the code's, not a request's. Its message
 * quotes no value all the same, since nothing stops a caller from passing one
 * a request chose.
 */
export function checkWait(name: string, wait: unknown): number {
	if (wait === undefined) return 0;
	if (typeof wait !== 'number' || !Number.isSafeInteger(wait) || wait < 0) {
		throw new TypeError(
			`run on "${name}": wait is a whole number of milliseconds, 0 or more`,
		);
	}
	return wait;
}

/**
 * `BEGIN`, and again while the key is running and `wait` has time left. It
 * returns what the last `BEGIN` found — the key taken, a result to replay, a
 * refusal, or still running once `wait` ran out — and `run` answers that as
 * it answers a single `BEGIN`.
 *
 * The host's clock only paces the sleeps between polls and says when `wait`
 * is spent; whether the key is free, done or running is the server's answer
 * every time. A `MISMATCH` or an `INVALID` found mid-wait ends it at once.
 */
export async function beginOrWait(
	client: RedisClient,
	key: string,
	token: string,
	fingerprint: string,
	lease: number,
	wait: number,
): Promise<Begun> {
	const deadline = performance.now() + wait;
	let pause = FIRST_POLL;
	for (;;) {
		const found = await begin(client, key, token, fingerprint, lease);
		const left = deadline - performance.now();
		if (found.state !== 'running' || left <= 0) return found;
		await Bun.sleep(Math.max(1, Math.min(found.pttl, pause, left)));
		pause = Math.min(pause * 2, LAST_POLL);
	}
}

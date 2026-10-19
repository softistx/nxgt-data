import type { RedisClient } from 'bun';
import { listen } from './subscriber';

/**
 * Listens on `channel` and races the subscription against `over`, so a hung
 * SUBSCRIBE cannot defeat a timeout. `raced` settles with the unlisten
 * function, or with `over`'s value when that came first. `stop` unlistens on
 * every path, even for an answer arriving after it, and returns a promise
 * that never rejects and settles once the unlisten finished. Most callers
 * leave it unawaited.
 */
export function listenRaced<O>(
	client: RedisClient,
	channel: string,
	onText: (text: string) => void,
	over: Promise<O>,
): { raced: Promise<unknown>; stop: () => Promise<void> } {
	const listening = listen(client, channel, onText);
	listening.catch(() => undefined);
	return {
		raced: Promise.race([listening, over]),
		stop: () =>
			// A hung UNSUBSCRIBE must not hold the outcome back: callers that
			// do not need it gone ignore the promise, which never rejects.
			listening.then(
				(off) => off().catch(() => undefined),
				() => undefined,
			),
	};
}

import type { RedisClient } from 'bun';
import { listen } from './subscriber';

/**
 * Listens on `channel` and races the subscription against `over`, so a hung
 * SUBSCRIBE cannot defeat a timeout. `raced` settles with the unlisten
 * function, or with `over`'s value when that came first. `stop` unlistens on
 * every path, never awaited: an answer arriving after `stop` is unlistened
 * as it lands.
 */
export function listenRaced<O>(
	client: RedisClient,
	channel: string,
	onText: (text: string) => void,
	over: Promise<O>,
): { raced: Promise<unknown>; stop: () => void } {
	let unlisten: (() => Promise<void>) | undefined;
	let stopped = false;
	const listening = listen(client, channel, onText);
	listening.then(
		(off) => {
			unlisten = off;
			if (stopped) off().catch(() => undefined);
		},
		() => undefined,
	);
	return {
		raced: Promise.race([listening, over]),
		stop() {
			stopped = true;
			// A hung UNSUBSCRIBE must not hold the outcome back.
			unlisten?.().catch(() => undefined);
		},
	};
}

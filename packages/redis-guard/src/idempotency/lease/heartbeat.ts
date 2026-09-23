import type { RedisClient } from 'bun';
import { renew } from '../scripts';

/** A lease being renewed: whether a renewal found it lost, and the stop. */
export interface Heartbeat {
	/** `true` once a renewal found the key gone, or another run's. */
	readonly lost: boolean;
	/** Stops the renewals. A renewal still in flight then reports nothing. */
	stop(): void;
}

/**
 * Renews a running record's lease every third of `lease`, while `work` runs.
 *
 * After `@nxgt/mongo-meilisearch`'s `keepLease`, sharing no code with it —
 * see AGENTS.md's table of deliberate duplications. A renewal that finds the
 * key gone or holding another token marks the lease lost and stops the beat:
 * nothing can give it back, and `run` then refuses to store. One that does
 * not reach Redis is tried again at the next beat, so the lease lapses only
 * when none reaches the server for a whole `lease` — a connection down that
 * long, or an event loop blocked that long, since a timer cannot fire while
 * synchronous work holds it.
 *
 * Each renewal's promise takes both its handlers where it is made: Bun ends
 * the process on a rejection nobody handles.
 */
export function keepLease(
	client: RedisClient,
	key: string,
	token: string,
	lease: number,
): Heartbeat {
	const state = { lost: false, stopped: false };
	const beat = setInterval(
		() => {
			renew(client, key, token, lease).then(
				(held) => {
					// A renewal still in flight when it was stopped reports nothing.
					if (held || state.stopped) return;
					state.lost = true;
					clearInterval(beat);
				},
				() => undefined, // tried again at the next beat
			);
		},
		Math.max(1, Math.floor(lease / 3)),
	);
	return {
		get lost() {
			return state.lost;
		},
		stop() {
			state.stopped = true;
			clearInterval(beat);
		},
	};
}

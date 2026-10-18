import type { RedisClient } from 'bun';
import type { queueKeys } from '../keys';
import { renew } from '../scripts/renew';

/** The leases a worker keeps alive. */
export type Leases = {
	/** Starts renewing a job's lease. */
	add(id: string, token: string): void;
	/** Stops renewing a job: it was settled. */
	delete(id: string): void;
	/** Stops every renewal; one still in flight then reports nothing. */
	stop(): void;
};

/**
 * Renews every held lease in one script per `lease / 3`, whatever the
 * worker's concurrency. An id whose token was taken (the lease lapsed and
 * another worker holds the job) is dropped from the renewals and reported to
 * `onLost`; the job's own late settle is refused by the token check.
 *
 * A renewal that does not reach Redis is tried again at the next beat, so a
 * lease lapses only when none gets through for a whole `lease`. Each
 * renewal's promise takes both handlers where it is made: Bun ends the
 * process on a rejection nobody handles.
 */
export function keepLeases(
	client: RedisClient,
	keys: ReturnType<typeof queueKeys>,
	lease: number,
	onLost: (ids: string[]) => void,
): Leases {
	const held = new Map<string, string>();
	let stopped = false;
	const beat = setInterval(
		() => {
			if (held.size === 0) return;
			const entries = [...held].map(([id, token]) => ({ id, token }));
			renew(client, keys, lease, entries).then(
				(lost) => {
					if (stopped || lost.length === 0) return;
					for (const id of lost) held.delete(id);
					try {
						onLost(lost);
					} catch {
						// A callback that throws must not end the beat.
					}
				},
				() => undefined, // tried again at the next beat
			);
		},
		Math.max(1, Math.floor(lease / 3)),
	);
	return {
		add: (id, token) => void held.set(id, token),
		delete: (id) => void held.delete(id),
		stop() {
			stopped = true;
			clearInterval(beat);
			held.clear();
		},
	};
}

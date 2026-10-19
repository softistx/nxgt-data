import type { RedisClient } from 'bun';
import type { queueKeys } from '../binding/keys';
import { renew } from '../scripts/renew';

/** The leases a worker keeps alive. */
export type Leases = {
	/** Starts renewing a job's lease. */
	add(id: string, token: string): void;
	/**
	 * Stops renewing a job: it was settled. Only when `token` is still the one
	 * held: a stale run that finishes after the id was claimed again must not
	 * end the new run's renewals.
	 */
	delete(id: string, token: string): void;
	/** Stops every renewal; one still in flight then reports nothing. */
	stop(): void;
};

/**
 * Renews every held lease in one script per `lease / 3`, whatever the
 * worker's concurrency. An id whose token was taken (the lease lapsed and
 * another worker holds the job) is dropped from the renewals and reported to
 * `onLost` with the token it held; the job's own late settle is refused by the token check.
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
	onLost: (lost: { id: string; token: string }[]) => void,
): Leases {
	const held = new Map<string, string>();
	let stopped = false;
	const beat = setInterval(
		() => {
			if (held.size === 0) return;
			const entries = [...held].map(([id, token]) => ({ id, token }));
			renew(client, keys, lease, entries).then(
				(lost) => {
					if (stopped) return;
					// Only the entry this renewal sent: the id may have been
					// settled and claimed again, under a new token, while it was
					// in flight, and that run must keep its renewals.
					const gone = entries.filter(
						(entry) =>
							lost.includes(entry.id) && held.get(entry.id) === entry.token,
					);
					if (gone.length === 0) return;
					for (const { id } of gone) held.delete(id);
					try {
						onLost(gone);
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
		delete(id, token) {
			if (held.get(id) === token) held.delete(id);
		},
		stop() {
			stopped = true;
			clearInterval(beat);
			held.clear();
		},
	};
}

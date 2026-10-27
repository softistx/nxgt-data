import type { Repository } from '../src/repository/types';

/**
 * Wraps `repository` to record when each backup was written: from the start
 * of its first object's `put` to the end of its last one (the manifest), in
 * the order the calls happened. Lock files are left out.
 *
 * Two runs started together may both store a backup — one after the other,
 * when the first's lock lands only once the second is done — so what the
 * lock promises is not "at most one stored" but `overlapping()` empty: no
 * two backups written at once.
 */
export function recordingWrites(repository: Repository): {
	repository: Repository;
	/** The pairs of backup ids whose writes interleaved. */
	overlapping(): [string, string][];
} {
	let clock = 0;
	const spans = new Map<string, { from: number; to: number }>();
	return {
		repository: {
			...repository,
			async put(key, file) {
				const id = key.includes('/locks/') ? undefined : key.split('/')[1];
				const from = clock++;
				await repository.put(key, file);
				if (id === undefined) return;
				const span = spans.get(id);
				spans.set(id, { from: span?.from ?? from, to: clock++ });
			},
		},
		overlapping() {
			const all = [...spans.entries()];
			const pairs: [string, string][] = [];
			for (const [i, [a, x]] of all.entries()) {
				for (const [b, y] of all.slice(i + 1)) {
					if (x.from < y.to && y.from < x.to) pairs.push([a, b]);
				}
			}
			return pairs;
		},
	};
}

import { describe, expect, test } from 'bun:test';
import { recordingWrites } from '../../test/writers';
import type { Repository } from '../repository/types';

/** A repository whose puts resolve only when told to. */
function held(): { repository: Repository; land: (key: string) => void } {
	const pending = new Map<string, () => void>();
	return {
		repository: {
			name: 'held',
			put: (key) => new Promise<void>((resolve) => pending.set(key, resolve)),
			get: async () => undefined,
			list: () => (async function* () {})(),
			delete: async () => undefined,
		},
		land: (key) => pending.get(key)?.(),
	};
}

describe('recordingWrites', () => {
	test('reports two backups whose writes interleave', async () => {
		const store = held();
		const recording = recordingWrites(store.repository);
		const a = recording.repository.put('app/a/0.age', '/f');
		const b = recording.repository.put('app/b/0.age', '/f');
		store.land('app/a/0.age');
		store.land('app/b/0.age');
		await Promise.all([a, b]);
		expect(recording.spans()).toBe(2);
		expect(recording.overlapping()).toEqual([['a', 'b']]);
	});

	test('reports none for writes one after the other, and leaves locks out', async () => {
		const store = held();
		const recording = recordingWrites(store.repository);
		const lock = recording.repository.put('app/locks/x.json', '/f');
		store.land('app/locks/x.json');
		await lock;
		for (const key of ['app/a/0.age', 'app/a/manifest.json', 'app/b/0.age']) {
			const put = recording.repository.put(key, '/f');
			store.land(key);
			await put;
		}
		expect(recording.spans()).toBe(2);
		expect(recording.overlapping()).toEqual([]);
	});
});

import { describe, expect, test } from 'bun:test';
import type { BackupContext } from '../backups/context';
import type { At } from '../backups/read';
import type { Manifest } from '../format/manifest';
import type { Repository } from '../repository/types';
import { locate } from './view';

const sha = 'a'.repeat(64);
const ctx = { backup: 'app' } as BackupContext;
const at: At = {
	call: 'restore',
	id: '20261004T000000000Z-00000002',
	repository: { name: 'local' } as Repository,
};
const parent = '20261003T000000000Z-00000001';
const manifest = (id: string, objects: number): Manifest => ({
	format: 'nxgt-backup/1',
	backup: 'app',
	id,
	createdAt: '2026-10-04T00:00:00.000Z',
	kind: 'full',
	parent: null,
	recipients: ['age1x'],
	compression: 'zstd',
	catalog: { key: 'catalog.age', size: 1, sha256: sha },
	objects: Array.from({ length: objects }, (_, i) => ({
		key: `${i}.age`,
		size: 1,
		sha256: sha,
	})),
});
const chain = new Map([
	[at.id, manifest(at.id, 1)],
	[parent, manifest(parent, 6)],
]);
const entry = (object: string, from?: string) => ({
	name: 'n',
	object,
	size: 1,
	sha256: sha,
	...(from === undefined ? {} : { in: from }),
});

describe('locate', () => {
	test('finds an object in the backup itself or in the one that stored it', () => {
		expect(locate(ctx, at, chain, entry('0.age'))).toEqual({
			at,
			object: { key: '0.age', size: 1, sha256: sha },
		});
		expect(locate(ctx, at, chain, entry('5.age', parent)).at.id).toBe(parent);
	});

	test.each([
		[
			'a backup outside the chain',
			entry('0.age', '20261001T000000000Z-00000009'),
			'restore on "app": the catalog names a backup outside its chain (repository "local")',
		],
		[
			'an object its holder lacks',
			entry('6.age', parent),
			'restore on "app": the catalog names an object the manifest lacks (repository "local")',
		],
		[
			'a key spelled another way',
			entry('05.age', parent),
			'restore on "app": the catalog names an object the manifest lacks (repository "local")',
		],
	])('refuses %s as INTEGRITY', (_, given, message) => {
		expect(() => locate(ctx, at, chain, given)).toThrow(message);
		try {
			locate(ctx, at, chain, given);
		} catch (error) {
			expect(error).toHaveProperty('code', 'INTEGRITY');
		}
	});
});

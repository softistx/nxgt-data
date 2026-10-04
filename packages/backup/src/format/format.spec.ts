import { describe, expect, test } from 'bun:test';
import { readCatalog } from './catalog';
import { isBackupId, newBackupId } from './ids';
import { readManifest } from './manifest';

const sha = 'a'.repeat(64);
const valid = {
	format: 'nxgt-backup/1',
	backup: 'app',
	id: '20261003T221500123Z-9f3a61c0',
	createdAt: '2026-10-03T22:15:00.123Z',
	kind: 'full',
	parent: null,
	recipients: ['age1xyz'],
	compression: 'zstd',
	catalog: { key: 'catalog.age', size: 10, sha256: sha },
	objects: [
		{ key: '0.age', size: 1, sha256: sha },
		{ key: '1.age', size: 0, sha256: sha },
	],
};

const edit = (change: Record<string, unknown>) =>
	JSON.stringify({ ...valid, ...change });

describe('ids', () => {
	test('sort as their times do, and are told apart', () => {
		const early = newBackupId(new Date('2026-01-02T03:04:05.006Z'));
		const late = newBackupId(new Date('2026-11-02T03:04:05.006Z'));
		expect(early).toMatch(/^20260102T030405006Z-[0-9a-f]{8}$/);
		expect(isBackupId(early)).toBe(true);
		expect([late, early].sort()).toEqual([early, late]);
		expect(isBackupId('../etc')).toBe(false);
	});
});

describe('readManifest', () => {
	test('keeps the known fields, and only them', () => {
		const read = readManifest(JSON.stringify({ ...valid, extra: 'x' }));
		expect(read).toEqual(valid as never);
	});

	test('reads one that builds on another', () => {
		const parent = '20261002T221500123Z-9f3a61c0';
		const read = readManifest(edit({ kind: 'incremental', parent }));
		expect(read).toMatchObject({ kind: 'incremental', parent });
	});

	test.each([
		['not JSON', '{', 'it is not JSON'],
		['an array', '[]', 'it is not a JSON object'],
		[
			'a newer format',
			edit({ format: 'nxgt-backup/2' }),
			'its format is one this version does not read',
		],
		[
			'another format',
			edit({ format: 'x' }),
			'it is not an nxgt-backup manifest',
		],
		['a bad name', edit({ backup: 'A/B' }), 'its backup name is not one'],
		['a bad id', edit({ id: '../x' }), 'its id is not a backup id'],
		[
			'a date not in ISO form',
			edit({ createdAt: '2026-10-03' }),
			'its createdAt is not an ISO date',
		],
		[
			'a kind it does not know',
			edit({ kind: 'snapshot' }),
			'its kind is not one this version reads',
		],
		[
			'an incremental with no parent',
			edit({ kind: 'incremental' }),
			'its parent does not fit its kind',
		],
		[
			'a full one with a parent',
			edit({ parent: '20261002T221500123Z-9f3a61c0' }),
			'its parent does not fit its kind',
		],
		[
			'a parent no older than the backup',
			edit({ kind: 'differential', parent: valid.id }),
			'its parent does not fit its kind',
		],
		[
			'a parent that is not an id',
			edit({ kind: 'incremental', parent: '../x' }),
			'its parent does not fit its kind',
		],
		[
			'no recipients',
			edit({ recipients: [] }),
			'its recipients are not age public keys',
		],
		[
			'a key outside the folder',
			edit({ objects: [{ key: '../0.age', size: 1, sha256: sha }] }),
			'an object key is not one this format writes',
		],
		[
			'objects out of order',
			edit({ objects: [{ key: '1.age', size: 1, sha256: sha }] }),
			'its objects are not numbered in order',
		],
		[
			'a negative size',
			edit({ objects: [{ key: '0.age', size: -1, sha256: sha }] }),
			'an object size is not a whole number of bytes',
		],
		[
			'a short digest',
			edit({ objects: [{ key: '0.age', size: 1, sha256: 'ab' }] }),
			'an object sha256 is not 64 hex digits',
		],
		[
			'a catalog under another key',
			edit({ catalog: { key: '0.age', size: 1, sha256: sha } }),
			'its catalog key is not catalog.age',
		],
	])('refuses %s', (_, text, problem) => {
		expect(readManifest(text)).toBe(problem);
	});
});

describe('readCatalog', () => {
	const entry = (name: string, index: number) => ({
		name,
		object: `${index}.age`,
		size: 1,
		sha256: sha,
	});
	const catalog = (entries: unknown[]) =>
		JSON.stringify({
			format: 'nxgt-backup-catalog/1',
			source: { kind: 'memory' },
			entries,
		});

	test('reads one that matches the manifest', () => {
		const read = readCatalog(catalog([entry('a', 0), entry('b', 1)]), 2);
		expect(
			typeof read === 'string' ? read : read.entries.map((e) => e.name),
		).toEqual(['a', 'b']);
	});

	test('reads entries stored in an older backup, a fingerprint and a position', () => {
		const elsewhere = {
			...entry('old', 7),
			in: '20261002T221500123Z-9f3a61c0',
			fingerprint: 'f',
		};
		const read = readCatalog(
			JSON.stringify({
				format: 'nxgt-backup-catalog/1',
				source: { kind: 'memory' },
				entries: [entry('a', 0), elsewhere, entry('b', 1)],
				position: 'p',
			}),
			2,
		);
		expect(read).toEqual({
			format: 'nxgt-backup-catalog/1',
			source: { kind: 'memory' },
			entries: [entry('a', 0), elsewhere, entry('b', 1)],
			position: 'p',
		});
	});

	test.each([
		[
			'an entry elsewhere with no id',
			catalog([{ ...entry('a', 0), in: '../x' }]),
			0,
			'an entry stored elsewhere does not say where',
		],
		[
			'an entry elsewhere under a bad key',
			catalog([
				{ ...entry('a', 0), in: '20261002T221500123Z-9f3a61c0', object: 'x' },
			]),
			0,
			'an entry stored elsewhere does not say where',
		],
		[
			'a fingerprint too long',
			catalog([{ ...entry('a', 0), fingerprint: 'f'.repeat(1025) }]),
			1,
			'an entry fingerprint is not one',
		],
		[
			'a position that is not text',
			JSON.stringify({
				format: 'nxgt-backup-catalog/1',
				source: { kind: 'memory' },
				entries: [],
				position: 5,
			}),
			0,
			'its position is not one',
		],
		[
			'a count that differs',
			catalog([entry('a', 0)]),
			2,
			'its entries do not match the manifest',
		],
		[
			'a name twice',
			catalog([entry('a', 0), entry('a', 1)]),
			2,
			'two entries have the same name',
		],
		['an empty name', catalog([entry('', 0)]), 1, 'an entry name is not one'],
		[
			'a NUL in a name',
			catalog([entry('a\0b', 0)]),
			1,
			'an entry name is not one',
		],
		[
			'entries out of order',
			catalog([entry('a', 1)]),
			1,
			'its entries do not follow the objects',
		],
		[
			'no source kind',
			JSON.stringify({ format: 'nxgt-backup-catalog/1', entries: [] }),
			0,
			'its source has no kind',
		],
	])('refuses %s', (_, text, objects, problem) => {
		expect(readCatalog(text, objects)).toBe(problem);
	});
});

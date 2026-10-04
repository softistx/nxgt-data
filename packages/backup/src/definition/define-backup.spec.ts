import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindBackup } from '../backups/bind-backup';
import { localRepository } from '../repository/local';
import { defineBackup } from './define-backup';

describe('defineBackup', () => {
	test('takes a name that can be a path segment', () => {
		expect(defineBackup({ name: 'app.db-1_x' }).name).toBe('app.db-1_x');
	});

	test.each([
		'',
		'App',
		'a/b',
		'.hidden',
		'-x',
		'a'.repeat(101),
		'é',
		'x.partial-y',
	])('refuses %p without quoting it', (name) => {
		expect(() => defineBackup({ name })).toThrow(
			'defineBackup: the name must be 1 to 100 characters',
		);
	});
});

describe('bindBackup', () => {
	const repository = localRepository({
		path: join(tmpdir(), 'nxgt-never-written'),
	});
	const recipient =
		'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq';

	test('refuses what could never work, before any I/O', () => {
		const app = defineBackup({ name: 'app' });
		const bind = (options: Record<string, unknown>) => () =>
			bindBackup(app, {
				repositories: [repository],
				recipients: [recipient],
				...options,
			} as never);
		expect(bind({})).not.toThrow();
		expect(bind({ repositories: [] })).toThrow('at least one repository');
		expect(bind({ repositories: [repository, repository] })).toThrow(
			'same name',
		);
		expect(bind({ recipients: [] })).toThrow('at least one age public key');
		expect(bind({ recipients: ['nope'] })).toThrow(
			'recipient 0 is not an age public key',
		);
		expect(bind({ tmpDir: 'tmp' })).toThrow('tmpDir must be an absolute path');
		expect(() =>
			bindBackup({ name: 'A/B' } as never, {
				repositories: [repository],
				recipients: [recipient],
			}),
		).toThrow('did not come from defineBackup');
	});

	test('a read from a repository it does not have is refused', () => {
		const backups = bindBackup(defineBackup({ name: 'app' }), {
			repositories: [repository],
			recipients: [recipient],
		});
		expect(backups.repositories).toEqual(['local']);
		expect(() => backups.list({ from: 'nope' })).toThrow(
			'no repository has that name',
		);
	});
});

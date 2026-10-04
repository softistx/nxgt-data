import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
	streamOf,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { defineBackup } from '../definition/define-backup';
import { localRepository } from '../repository/local';
import type { BackupSource, RestoreTarget } from '../source/types';
import { bindBackup } from './bind-backup';

let root: Awaited<ReturnType<typeof folder>>;
let keys: KeyPair;

beforeEach(async () => {
	root = await folder();
	keys = await keyPair();
});
afterEach(() => root.remove());

function bound() {
	return bindBackup(defineBackup({ name: 'app' }), {
		repositories: [localRepository({ path: join(root.path, 'repo') })],
		recipients: [keys.recipient],
		tmpDir: root.path,
	});
}

function named(...names: string[]): BackupSource {
	return {
		kind: 'test',
		async *entries() {
			for (const name of names) yield { name, open: () => streamOf('x') };
		},
	};
}

describe('what a source must give', () => {
	test.each([
		['a name given twice', ['secret-a', 'secret-a']],
		['an empty name', ['']],
		['a NUL in a name', ['secret\0b']],
	])('%s is a TypeError that quotes none, and no backup', async (_, names) => {
		const backups = bound();
		const error = await rejection(backups.create(named(...names)));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'create on "app": the source gave an entry name that is empty, ' +
				'over 4096 characters, holds a NUL, or was given twice',
		);
		expect((error as Error).message).not.toContain('secret');
		expect((await backups.list()).backups).toEqual([]);
	});
});

describe('what a caller must give', () => {
	test('an id that is not one is a TypeError, before any read', async () => {
		const error = await rejection(bound().verify('../../etc'));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'verify on "app": the id is not a backup id',
		);
	});

	test('a target that resolves before reading to the end is refused', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource({ a: 'alpha' }));
		const hasty: RestoreTarget = {
			async write(_, stream) {
				await stream.getReader().read();
			},
		};
		const error = await rejection(
			backups.restore(id, hasty, { identities: [keys.identity] }),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'restore on "app": the target resolved write before reading its stream ' +
				'to the end, so nothing it was given was checked',
		);
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindBackup } from '../backups/bind-backup';
import type { BindBackupOptions } from '../backups/context';
import { generateSigningKeys } from '../crypto/signing';
import { defineBackup } from '../definition/define-backup';
import type { RepositoryOutcome } from '../errors/backup-error';
import { newBackupId } from '../format/ids';
import { LOCK_FORMAT } from '../lock/lock';
import { localRepository } from '../repository/local';

const app = defineBackup({ name: 'app' });

let root: Awaited<ReturnType<typeof folder>>;
let keys: KeyPair;

beforeEach(async () => {
	root = await folder();
	keys = await keyPair();
});
afterEach(() => root.remove());

const local = (name = 'local') =>
	localRepository({ path: join(root.path, name), name });

function bound(options: Partial<BindBackupOptions> = {}) {
	return bindBackup(app, {
		repositories: [local()],
		recipients: [keys.recipient],
		tmpDir: root.path,
		...options,
	});
}

const incremental = () =>
	({ kind: 'incremental', identities: [keys.identity] }) as const;

const manifestPath = (id: string, repository = 'local') =>
	join(root.path, repository, 'app', id, 'manifest.json');

/** Leaves a live lock of another create in `repository`. */
async function lockedByCreate(repository: string): Promise<void> {
	const id = newBackupId(new Date());
	const locks = join(root.path, repository, 'app', 'locks');
	await mkdir(locks, { recursive: true });
	await writeFile(
		join(locks, `${id}.json`),
		JSON.stringify({
			format: LOCK_FORMAT,
			id,
			operation: 'create',
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		}),
	);
}

describe('a chain kept whole', () => {
	test('prune keeps the parent of a backup it cannot read', async () => {
		const backups = bound();
		const full = await backups.create(memorySource({ a: 'a' }));
		const next = await backups.create(memorySource({ a: 'b' }), incremental());
		await backups.create(memorySource({ a: 'c' }));
		// A kind a newer version might write: unreadable here, parent intact.
		const text = await readFile(manifestPath(next.id), 'utf8');
		await writeFile(
			manifestPath(next.id),
			text.replace('"incremental"', '"snapshot"'),
		);
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.unreadable).toEqual([next.id]);
		expect(pruned.kept.map((d) => [d.id, d.reasons])).toContainEqual([
			full.id,
			[`parent of ${next.id}`],
		]);
		expect(pruned.kept.map((d) => d.id)).not.toContain(next.id);
		expect(pruned.removed).toEqual([]);
	});

	test('create refuses a base whose own chain is broken', async () => {
		const backups = bound();
		const full = await backups.create(memorySource({ a: 'a' }));
		await backups.create(memorySource({ a: 'b' }), incremental());
		await rm(join(root.path, 'local', 'app', full.id), { recursive: true });
		const error = await rejection(
			backups.create(memorySource({ a: 'c' }), incremental()),
		);
		expect(error).toHaveProperty('code', 'INTEGRITY');
		expect(error).toHaveProperty(
			'message',
			'create on "app": a backup it builds on is missing (repository "local")',
		);
	});

	test('a repository whose copy of the chain is broken is left out', async () => {
		const both = bound({ repositories: [local('first'), local('second')] });
		const full = await both.create(memorySource({ a: 'a' }));
		await both.create(memorySource({ a: 'b' }), incremental());
		await rm(join(root.path, 'second', 'app', full.id), { recursive: true });
		const error = await rejection(
			both.create(memorySource({ a: 'c' }), incremental()),
		);
		expect(error).toHaveProperty('code', 'PARTIAL');
		const [first, second] = (error as { outcomes: RepositoryOutcome[] })
			.outcomes;
		expect(first).toEqual({ repository: 'first', stored: true });
		expect(second?.stored === false && second.error).toHaveProperty(
			'code',
			'INTEGRITY',
		);
	});

	test('a base encrypted to other recipients is refused', async () => {
		const other = await keyPair();
		await bound().create(memorySource({ a: 'a' }));
		const rekeyed = bound({ recipients: [other.recipient] });
		const error = await rejection(
			rekeyed.create(memorySource({ a: 'a' }), {
				kind: 'incremental',
				identities: [keys.identity],
			}),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(error).toHaveProperty(
			'message',
			'create on "app": the backup it builds on is encrypted to other recipients; make a full backup first',
		);
	});

	test('so is one encrypted to a recipient since removed', async () => {
		const removed = await keyPair();
		await bound({ recipients: [keys.recipient, removed.recipient] }).create(
			memorySource({ a: 'a' }),
		);
		const error = await rejection(
			bound().create(memorySource({ a: 'a' }), incremental()),
		);
		expect(error).toBeInstanceOf(TypeError);
	});

	test('an ancestor no trusted key signed stops the chain', async () => {
		const signing = generateSigningKeys();
		const writer = bound({ signing: { key: signing.privateKey } });
		const full = await writer.create(memorySource({ a: 'a' }));
		const next = await writer.create(memorySource({ a: 'b' }), incremental());
		await rm(join(root.path, 'local', 'app', full.id, 'manifest.sig'));
		const reader = bound({ trusted: [signing.publicKey] });
		const error = await rejection(reader.verify(next.id));
		expect(error).toHaveProperty('code', 'SIGNATURE');
		expect(error).toHaveProperty('id', full.id);
	});
});

describe('the repository the base is read from', () => {
	test('by default, the first one still in the run', async () => {
		const both = bound({ repositories: [local('first'), local('second')] });
		const full = await both.create(memorySource({ a: 'a' }));
		await lockedByCreate('first');
		const error = await rejection(
			both.create(memorySource({ a: 'b' }), incremental()),
		);
		expect(error).toHaveProperty('code', 'PARTIAL');
		const [first, second] = (error as { outcomes: RepositoryOutcome[] })
			.outcomes;
		expect(first?.stored === false && first.error).toHaveProperty(
			'code',
			'LOCKED',
		);
		expect(second).toEqual({ repository: 'second', stored: true });
		const listed = await both.list({ from: 'second' });
		expect(listed.backups.at(-1)?.parent).toBe(full.id);
	});

	test('one named and locked is refused with its own error', async () => {
		const both = bound({ repositories: [local('first'), local('second')] });
		await both.create(memorySource({ a: 'a' }));
		await lockedByCreate('first');
		const error = await rejection(
			both.create(memorySource({ a: 'b' }), {
				...incremental(),
				from: 'first',
			}),
		);
		expect(error).toHaveProperty('code', 'LOCKED');
	});
});

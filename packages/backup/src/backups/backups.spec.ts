import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Encrypter } from 'age-encryption';
import {
	bytes,
	folder,
	type KeyPair,
	keyPair,
	memorySource,
	memoryTarget,
	recording,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { defineBackup } from '../definition/define-backup';
import { BackupError } from '../errors/backup-error';
import { localRepository } from '../repository/local';
import { directoryTarget } from '../source/directory';
import { bindBackup } from './bind-backup';

const app = defineBackup({ name: 'app' });

let root: Awaited<ReturnType<typeof folder>>;
let keys: KeyPair;

beforeEach(async () => {
	root = await folder();
	keys = await keyPair();
});
afterEach(() => root.remove());

function local(name = 'local') {
	return localRepository({ path: join(root.path, name), name });
}

function bound(
	repositories = [local()] as [
		ReturnType<typeof local>,
		...ReturnType<typeof local>[],
	],
) {
	return bindBackup(app, {
		repositories,
		recipients: [keys.recipient],
		tmpDir: root.path,
	});
}

const files = {
	'a.txt': 'alpha',
	'nested/b.bin': bytes(300_000),
	empty: '',
};

async function backupError(promise: Promise<unknown>): Promise<BackupError> {
	const error = await rejection(promise);
	if (!(error instanceof BackupError)) throw error;
	return error;
}

describe('a full backup, and back', () => {
	test('create, list, verify and restore give back every byte', async () => {
		const backups = bound();
		const created = await backups.create(memorySource(files));
		expect(created.entries).toBe(3);
		expect(created.size).toBe(5 + 300_000);
		expect(created.outcomes).toEqual([{ repository: 'local', stored: true }]);

		const listing = await backups.list();
		expect(listing.backups.map((b) => b.id)).toEqual([created.id]);
		expect(listing.unreadable).toEqual([]);

		expect((await backups.verify(created.id)).decrypted).toBe(false);
		const deep = await backups.verify(created.id, {
			identities: [keys.identity],
		});
		expect(deep).toMatchObject({ objects: 4, decrypted: true });

		const target = memoryTarget();
		const restored = await backups.restore(created.id, target, {
			identities: [keys.identity],
		});
		expect(restored.entries).toEqual(['a.txt', 'nested/b.bin', 'empty']);
		expect(new TextDecoder().decode(target.written.get('a.txt'))).toBe('alpha');
		expect(target.written.get('nested/b.bin')).toEqual(bytes(300_000));
		expect(target.written.get('empty')).toEqual(new Uint8Array());
	});

	test('only takes back the entries named, or the ones a test keeps', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource(files));
		const named = memoryTarget();
		await backups.restore(id, named, {
			identities: [keys.identity],
			only: ['a.txt'],
		});
		expect([...named.written.keys()]).toEqual(['a.txt']);
		const tested = memoryTarget();
		await backups.restore(id, tested, {
			identities: [keys.identity],
			only: (name) => name.startsWith('nested/'),
		});
		expect([...tested.written.keys()]).toEqual(['nested/b.bin']);
		const error = await backupError(
			backups.restore(id, memoryTarget(), {
				identities: [keys.identity],
				only: ['nope'],
			}),
		);
		expect(error.code).toBe('NOT_FOUND');
	});

	test('no name, no content: the repository holds neither in the clear', async () => {
		const backups = bound();
		const secret = 'customers-2026-export.csv';
		await backups.create(memorySource({ [secret]: 'card numbers' }));
		for await (const key of local().list('')) {
			const text = await readFile(join(root.path, 'local', key), 'latin1');
			expect(text.includes(secret) || text.includes('card numbers')).toBe(
				false,
			);
			expect(key.includes(secret)).toBe(false);
		}
	});

	test('a hybrid post-quantum recipient, and several recipients, each open it', async () => {
		const pq = await keyPair(true);
		const backups = bindBackup(app, {
			repositories: [local()],
			recipients: [pq.recipient],
			tmpDir: root.path,
		});
		const { id } = await backups.create(memorySource(files));
		expect(
			(await backups.verify(id, { identities: [pq.identity] })).decrypted,
		).toBe(true);

		const other = await keyPair();
		const both = bindBackup(defineBackup({ name: 'both' }), {
			repositories: [local()],
			recipients: [keys.recipient, other.recipient],
			tmpDir: root.path,
		});
		const created = await both.create(memorySource(files));
		for (const identity of [keys.identity, other.identity]) {
			expect(
				(await both.verify(created.id, { identities: [identity] })).decrypted,
			).toBe(true);
		}
	});
});

describe('what a repository is not trusted with', () => {
	test('an identity that opens nothing is DECRYPT', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource(files));
		const stranger = await keyPair();
		const error = await backupError(
			backups.restore(id, memoryTarget(), { identities: [stranger.identity] }),
		);
		expect(error.code).toBe('DECRYPT');
		expect(error.repository).toBe('local');
	});

	test('a flipped byte is INTEGRITY, with or without a key, and reaches no target', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource(files));
		const object = join(root.path, 'local', 'app', id, '1.age');
		const stored = await readFile(object);
		stored[stored.length >> 1] = (stored[stored.length >> 1] as number) ^ 1;
		await writeFile(object, stored);

		expect((await backupError(backups.verify(id))).code).toBe('INTEGRITY');
		const target = memoryTarget();
		const error = await backupError(
			backups.restore(id, target, { identities: [keys.identity] }),
		);
		expect(error.code).toBe('INTEGRITY');
		// Checked before a byte of it is decrypted: the target never sees it.
		expect(target.attempted).toEqual(['a.txt']);
	});

	test('an object forged with the public key, valid age, is INTEGRITY', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource(files));
		const forger = new Encrypter();
		forger.addRecipient(keys.recipient);
		const forged = (await forger.encrypt(
			new Uint8Array([1, 2, 3]),
		)) as Uint8Array;
		await writeFile(join(root.path, 'local', 'app', id, '0.age'), forged);
		const target = memoryTarget();
		const error = await backupError(
			backups.restore(id, target, { identities: [keys.identity] }),
		);
		expect(error.code).toBe('INTEGRITY');
		expect(target.attempted).toEqual([]);
	});

	test('an object and its manifest rewritten together still fail the catalog, and land nothing', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource({ 'a.txt': 'alpha' }));
		const dir = join(root.path, 'local', 'app', id);
		// Valid zstd in valid age, to the backup's own public key.
		const forger = new Encrypter();
		forger.addRecipient(keys.recipient);
		const compressed = Bun.zstdCompressSync(new TextEncoder().encode('omega'));
		const forged = (await forger.encrypt(compressed)) as Uint8Array;
		await writeFile(join(dir, '0.age'), forged);
		const manifest = JSON.parse(
			await readFile(join(dir, 'manifest.json'), 'utf8'),
		);
		manifest.objects[0] = {
			key: '0.age',
			size: forged.byteLength,
			sha256: new Bun.CryptoHasher('sha256').update(forged).digest('hex'),
		};
		await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

		const out = await folder();
		try {
			const error = await backupError(
				backups.restore(id, directoryTarget({ path: out.path }), {
					identities: [keys.identity],
				}),
			);
			expect(error.code).toBe('INTEGRITY');
			expect(await readdir(out.path)).toEqual([]);
		} finally {
			await out.remove();
		}
	});

	test('a manifest moved from another backup, or edited, is INTEGRITY', async () => {
		const backups = bound();
		const first = await backups.create(memorySource(files));
		const second = await backups.create(memorySource({ x: 'y' }));
		const dir = (id: string) => join(root.path, 'local', 'app', id);
		await writeFile(
			join(dir(second.id), 'manifest.json'),
			await readFile(join(dir(first.id), 'manifest.json')),
		);
		expect((await backupError(backups.verify(second.id))).code).toBe(
			'INTEGRITY',
		);
		await writeFile(
			join(dir(first.id), 'manifest.json'),
			'{"format":"nxgt-backup/9"}',
		);
		expect((await backupError(backups.verify(first.id))).code).toBe(
			'INTEGRITY',
		);
		expect((await backups.list()).unreadable.sort()).toEqual(
			[first.id, second.id].sort(),
		);
	});

	test('a backup without its manifest does not exist', async () => {
		const backups = bound();
		const { id } = await backups.create(memorySource(files));
		await local().delete(`app/${id}/manifest.json`);
		expect((await backups.list()).backups).toEqual([]);
		expect((await backupError(backups.verify(id))).code).toBe('NOT_FOUND');
	});
});

describe('several repositories', () => {
	test('every one holds it, and the manifest goes last in each', async () => {
		const one = recording(local('one'));
		const two = recording(local('two'));
		const backups = bindBackup(app, {
			repositories: [one, two],
			recipients: [keys.recipient],
			tmpDir: root.path,
		});
		const { id, outcomes } = await backups.create(memorySource(files));
		expect(outcomes.every((outcome) => outcome.stored)).toBe(true);
		for (const repository of [one, two]) {
			expect(repository.puts.at(-1)).toBe(`app/${id}/manifest.json`);
			expect(repository.puts).toHaveLength(5);
			await backups.verify(id, {
				from: repository.name,
				identities: [keys.identity],
			});
		}
	});

	test('one that fails is PARTIAL: the other is complete, the failed one has no manifest', async () => {
		const good = recording(local('good'));
		const bad = recording(local('bad'), { failFrom: 1 });
		const backups = bindBackup(app, {
			repositories: [good, bad],
			recipients: [keys.recipient],
			tmpDir: root.path,
		});
		const error = await backupError(backups.create(memorySource(files)));
		expect(error.code).toBe('PARTIAL');
		expect(error.outcomes.map((o) => [o.repository, o.stored])).toEqual([
			['good', true],
			['bad', false],
		]);
		expect(bad.puts).toHaveLength(1);
		const id = error.id as string;
		await backups.verify(id, { from: 'good', identities: [keys.identity] });
		expect((await backupError(backups.verify(id, { from: 'bad' }))).code).toBe(
			'NOT_FOUND',
		);
	});

	test('when all fail it is NOT_STORED, and the source is not read further', async () => {
		const bad = recording(local('bad'), { failFrom: 0 });
		const backups = bindBackup(app, {
			repositories: [bad],
			recipients: [keys.recipient],
			tmpDir: root.path,
		});
		const source = memorySource(files);
		const error = await backupError(backups.create(source));
		expect(error.code).toBe('NOT_STORED');
		expect(source.opened).toEqual(['a.txt']);
		const outcome = error.outcomes[0];
		expect(outcome?.stored).toBe(false);
	});
});

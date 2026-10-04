import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
	memoryTarget,
	recording,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { generateSigningKeys, type SigningKeys } from '../crypto/signing';
import { defineBackup } from '../definition/define-backup';
import { BackupError } from '../errors/backup-error';
import { localRepository } from '../repository/local';
import type { Repository } from '../repository/types';
import { directoryTarget } from '../source/directory';
import { bindBackup } from './bind-backup';
import type { BindBackupOptions } from './context';

const app = defineBackup({ name: 'app' });

let root: Awaited<ReturnType<typeof folder>>;
let keys: KeyPair;
let signing: SigningKeys;

beforeEach(async () => {
	root = await folder();
	keys = await keyPair();
	signing = generateSigningKeys();
});
afterEach(() => root.remove());

function local() {
	return localRepository({ path: join(root.path, 'local') });
}

/** A writer holds the private key; a reader only the public one. */
function bound(options: Partial<BindBackupOptions> = {}) {
	return bindBackup(app, {
		repositories: [local()],
		recipients: [keys.recipient],
		tmpDir: root.path,
		...options,
	});
}

const writer = () => bound({ signing: { key: signing.privateKey } });
const reader = () => bound({ trusted: [signing.publicKey] });

async function backupError(promise: Promise<unknown>): Promise<BackupError> {
	const error = await rejection(promise);
	if (!(error instanceof BackupError)) throw error;
	return error;
}

describe('a signed backup', () => {
	test('is signed by the writer, and read by a reader holding the public key', async () => {
		const created = await writer().create(memorySource({ 'a.txt': 'alpha' }));
		expect(created.signed).toBe(true);
		const signature = await readFile(
			join(root.path, 'local', 'app', created.id, 'manifest.sig'),
		);
		expect(signature.byteLength).toBe(64);

		const backups = reader();
		expect((await backups.list()).backups.map((b) => b.id)).toEqual([
			created.id,
		]);
		const verified = await backups.verify(created.id);
		expect(verified.signatureChecked).toBe(true);
		const target = memoryTarget();
		await backups.restore(created.id, target, { identities: [keys.identity] });
		expect(new TextDecoder().decode(target.written.get('a.txt'))).toBe('alpha');
	});

	test('the signature goes in just before the manifest, in every repository', async () => {
		const repository = recording(local());
		await bindBackup(app, {
			repositories: [repository],
			recipients: [keys.recipient],
			tmpDir: root.path,
			signing: { key: signing.privateKey },
		}).create(memorySource({ a: 'x' }));
		expect(repository.puts.map((key) => key.split('/')[2])).toEqual([
			'0.age',
			'catalog.age',
			'manifest.sig',
			'manifest.json',
		]);
	});

	test('without trusted keys nothing is checked, as before signing existed', async () => {
		const { id } = await writer().create(memorySource({ a: 'x' }));
		expect((await bound().verify(id)).signatureChecked).toBe(false);
	});
});

describe('what a signature refuses', () => {
	test('a whole backup written by someone without the key: SIGNATURE, and nothing lands', async () => {
		// Read access is enough to have the recipients: they are in every
		// manifest. Write access is enough to put a consistent backup.
		const forged = await bound().create(memorySource({ 'a.txt': 'omega' }));
		const otherKey = await bound({
			signing: { key: generateSigningKeys().privateKey },
		}).create(memorySource({ 'a.txt': 'omega' }));

		const backups = reader();
		const listing = await backups.list();
		expect(listing.backups).toEqual([]);
		expect(listing.unreadable.sort()).toEqual([forged.id, otherKey.id].sort());

		const out = await folder();
		try {
			for (const [id, message] of [
				[forged.id, 'the manifest is not signed'],
				[otherKey.id, 'no trusted key signed the manifest'],
			] as const) {
				const error = await backupError(
					backups.restore(id, directoryTarget({ path: out.path }), {
						identities: [keys.identity],
					}),
				);
				expect(error.code).toBe('SIGNATURE');
				expect(error.message).toBe(
					`restore on "app": ${message} (repository "local")`,
				);
			}
			expect(await readdir(out.path)).toEqual([]);
		} finally {
			await out.remove();
		}
	});

	test('a signed manifest edited, or another backup’s signature moved in: SIGNATURE', async () => {
		const first = await writer().create(memorySource({ a: 'x' }));
		const second = await writer().create(memorySource({ a: 'y' }));
		const dir = (id: string) => join(root.path, 'local', 'app', id);
		await writeFile(
			join(dir(first.id), 'manifest.sig'),
			await readFile(join(dir(second.id), 'manifest.sig')),
		);
		const text = await readFile(join(dir(second.id), 'manifest.json'), 'utf8');
		await writeFile(
			join(dir(second.id), 'manifest.json'),
			text.replace('"zstd"', '"zstd" '),
		);
		for (const { id } of [first, second]) {
			expect((await backupError(reader().verify(id))).code).toBe('SIGNATURE');
		}
	});

	test('a signature file is read no further than a signature', async () => {
		const { id } = await writer().create(memorySource({ a: 'x' }));
		const inner = local();
		let pulled = 0;
		const huge: Repository = {
			...inner,
			get: async (key) =>
				key.endsWith('/manifest.sig')
					? new ReadableStream<Uint8Array>({
							pull(controller) {
								if (pulled >= 64 * 1024 * 1024) return controller.close();
								pulled += 1024;
								controller.enqueue(new Uint8Array(1024));
							},
						})
					: inner.get(key),
		};
		const backups = bindBackup(app, {
			repositories: [huge],
			recipients: [keys.recipient],
			tmpDir: root.path,
			trusted: [signing.publicKey],
		});
		expect((await backupError(backups.verify(id))).code).toBe('SIGNATURE');
		expect(pulled).toBeLessThan(16 * 1024);
	});
});

describe('what is checked first', () => {
	test('the signature, before the manifest is parsed: garbage unsigned is SIGNATURE', async () => {
		const { id } = await writer().create(memorySource({ a: 'x' }));
		const dir = join(root.path, 'local', 'app', id);
		await writeFile(join(dir, 'manifest.json'), 'not json');
		expect((await backupError(reader().verify(id))).code).toBe('SIGNATURE');
		// Without trusted keys the same bytes are INTEGRITY: they do not parse.
		expect((await backupError(bound().verify(id))).code).toBe('INTEGRITY');
	});

	test('a signature with one byte more is not a signature', async () => {
		const { id } = await writer().create(memorySource({ a: 'x' }));
		const file = join(root.path, 'local', 'app', id, 'manifest.sig');
		await writeFile(
			file,
			Buffer.concat([await readFile(file), Buffer.from([0])]),
		);
		expect((await backupError(reader().verify(id))).code).toBe('SIGNATURE');
	});

	test('a manifest is read no further than 64 MiB', async () => {
		const { id } = await writer().create(memorySource({ a: 'x' }));
		const inner = local();
		let pulled = 0;
		const huge: Repository = {
			...inner,
			get: async (key) =>
				key.endsWith('/manifest.json')
					? new ReadableStream<Uint8Array>({
							pull(controller) {
								if (pulled >= 256 * 1024 * 1024) return controller.close();
								pulled += 1024 * 1024;
								controller.enqueue(new Uint8Array(1024 * 1024));
							},
						})
					: inner.get(key),
		};
		const backups = bindBackup(app, {
			repositories: [huge],
			recipients: [keys.recipient],
			tmpDir: root.path,
			trusted: [signing.publicKey],
		});
		const error = await backupError(backups.verify(id));
		expect(error.message).toBe(
			'verify on "app": the manifest is larger than 64 MiB (repository "local")',
		);
		expect(pulled).toBeLessThanOrEqual(66 * 1024 * 1024);
	});
});

describe('several repositories, signed', () => {
	test('one that fails on the signature gets no manifest, and holds no backup', async () => {
		const good = recording(
			localRepository({ path: join(root.path, 'good'), name: 'good' }),
		);
		const bad = recording(
			localRepository({ path: join(root.path, 'bad'), name: 'bad' }),
			{
				failFrom: 2,
			},
		);
		const backups = bindBackup(app, {
			repositories: [good, bad],
			recipients: [keys.recipient],
			tmpDir: root.path,
			signing: { key: signing.privateKey },
		});
		const error = await backupError(backups.create(memorySource({ a: 'x' })));
		expect(error.code).toBe('PARTIAL');
		expect(bad.puts.map((key) => key.split('/')[2])).toEqual([
			'0.age',
			'catalog.age',
		]);
		expect(good.puts.map((key) => key.split('/')[2])).toEqual([
			'0.age',
			'catalog.age',
			'manifest.sig',
			'manifest.json',
		]);
		const id = error.id as string;
		expect((await backups.verify(id, { from: 'good' })).signatureChecked).toBe(
			true,
		);
		expect((await backupError(backups.verify(id, { from: 'bad' }))).code).toBe(
			'NOT_FOUND',
		);
	});
});

describe('keys that could never work', () => {
	test.each([
		[
			'a private key that is not Ed25519, or not a key',
			{ signing: { key: 'SECRETSECRET' } },
			'bindBackup: signing.key is not an Ed25519 private key (PEM, PKCS#8)',
		],
		[
			'a private key among the trusted ones',
			{ trusted: ['-----BEGIN PRIVATE KEY-----\nSECRETSECRET\n'] },
			'bindBackup: trusted 0 is a private key; give its public key',
		],
		[
			'a trusted key that is not one',
			{ trusted: ['SECRETSECRET'] },
			'bindBackup: trusted 0 is not an Ed25519 public key (PEM, SPKI)',
		],
		[
			'no trusted key',
			{ trusted: [] },
			'bindBackup: trusted must list at least one public key',
		],
	])('%s is a TypeError that quotes nothing', (_, options, message) => {
		let error: unknown;
		try {
			bound(options as never);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(message);
		expect((error as Error).cause).toBeUndefined();
		expect((error as Error).message).not.toContain('SECRET');
	});

	test('a reader that creates is refused: what it wrote, it could not read', async () => {
		const error = await rejection(reader().create(memorySource({ a: 'x' })));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'create on "app": trusted keys are set but no signing key, ' +
				'so this backup could not read what it writes',
		);
		expect(await readdir(root.path)).not.toContain('local');
	});

	test('a writer whose trusted keys leave out its own could not read what it writes', () => {
		expect(() =>
			bound({
				signing: { key: signing.privateKey },
				trusted: [generateSigningKeys().publicKey],
			}),
		).toThrow(
			'bindBackup: trusted does not hold the public key of signing.key, ' +
				'so this backup could not read what it writes',
		);
		expect(() =>
			bound({
				signing: { key: signing.privateKey },
				trusted: [generateSigningKeys().publicKey, signing.publicKey],
			}),
		).not.toThrow();
	});
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
	chmod,
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejection } from '../../test/rejection';
import { generateKeyFile, readKeyFile } from './key-file';

let folder: string;
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), 'nxgt-key-file-'));
});
afterEach(() => rm(folder, { recursive: true, force: true }));

describe('the key file', () => {
	test('is written for its owner alone, never over another, and read back', async () => {
		const path = join(folder, 'backup.key');
		const { recipient } = await generateKeyFile(path);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const keys = await readKeyFile(path);
		expect(keys.recipient).toBe(recipient);
		expect(keys.recipient.startsWith('age1')).toBe(true);
		expect(keys.identity.startsWith('AGE-SECRET-KEY-1')).toBe(true);
		expect(keys.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
		const before = await readFile(path, 'utf8');
		expect(await rejection(generateKeyFile(path))).toHaveProperty(
			'code',
			'EEXIST',
		);
		expect(await readFile(path, 'utf8')).toBe(before);
	});

	test('is removed when its write fails, so keygen can be run again', async () => {
		const probe = await open(join(folder, 'probe'), 'w');
		const proto = Object.getPrototypeOf(probe);
		await probe.close();
		const path = join(folder, 'backup.key');
		const spy = spyOn(proto, 'writeFile').mockRejectedValue(
			new Error('disk full'),
		);
		try {
			expect(await rejection(generateKeyFile(path))).toHaveProperty(
				'message',
				'disk full',
			);
		} finally {
			spy.mockRestore();
		}
		expect(await rejection(stat(path))).toHaveProperty('code', 'ENOENT');
		await generateKeyFile(path);
	});

	test('is refused when others can read it, or when keygen did not write it', async () => {
		const path = join(folder, 'backup.key');
		await generateKeyFile(path);
		await chmod(path, 0o640);
		const open = await rejection(readKeyFile(path));
		expect(open).toHaveProperty('code', 'KEY_FILE');
		expect(open).toHaveProperty(
			'message',
			'readKeyFile: others than its owner can read or write the key file; chmod 600 it',
		);
		// Any other failure to reach it is the file system's, as it is.
		const through = await rejection(readKeyFile(join(path, 'inside')));
		expect(through).toHaveProperty('code', 'ENOTDIR');
		const text = await readFile(path, 'utf8');
		for (const broken of [
			'',
			text.replace(/AGE-SECRET-KEY-1\S+/, ''),
			text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]+$/, ''),
			text.replace(/(BEGIN PRIVATE KEY-----\n)\S{8}/, '$1AAAAAAAA'),
			// Not Ed25519: bindBackup would refuse it later, under its own name.
			text.replace(
				/-----BEGIN PRIVATE KEY-----[\s\S]+$/,
				generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
					type: 'pkcs8',
					format: 'pem',
				}) as string,
			),
			// A bad checksum: age's own error quotes the whole secret.
			text.replace(
				/(AGE-SECRET-KEY-1\S+)(\S)$/m,
				(_, head, last) => `${head}${last === 'Q' ? 'P' : 'Q'}`,
			),
		]) {
			const other = join(folder, `${crypto.randomUUID()}.key`);
			await writeFile(other, broken, { mode: 0o600 });
			const error = await rejection(readKeyFile(other));
			expect(error).toHaveProperty('code', 'KEY_FILE');
			expect(String((error as Error).message)).not.toContain('AGE-SECRET');
			expect((error as Error).cause).toBeUndefined();
			expect(error).toHaveProperty(
				'message',
				'readKeyFile: the key file is not one keygen wrote',
			);
		}
	});
});

describe('nxgt-mongo-backup keygen', () => {
	const cli = join(import.meta.dir, '..', 'cli.ts');
	const run = (...args: string[]) =>
		Bun.spawnSync(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });

	test('writes a key file and prints its recipient, never a secret', async () => {
		const path = join(folder, 'backup.key');
		const first = run('keygen', path);
		expect(first.exitCode).toBe(0);
		const out = first.stdout.toString();
		const { recipient, identity } = await readKeyFile(path);
		expect(out).toContain(`recipient: ${recipient}`);
		expect(out).not.toContain(identity);
		expect(out).not.toContain('PRIVATE KEY');
		const again = run('keygen', path);
		expect(again.exitCode).toBe(1);
		expect(again.stderr.toString()).toContain('is already there');
		expect(run('keygen').exitCode).toBe(2);
		const help = run('--help');
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain(
			'usage: nxgt-mongo-backup keygen <path>',
		);
		const nowhere = run('keygen', join(folder, 'missing', 'backup.key'));
		expect(nowhere.exitCode).toBe(1);
		expect(nowhere.stderr.toString()).toStartWith('keygen failed: ');
		expect(run('other', path).exitCode).toBe(2);
	});
});

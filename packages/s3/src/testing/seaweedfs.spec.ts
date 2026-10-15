import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assetFor,
	defaultCacheDir,
	download,
	seaweedfsBinary,
	TEST_SEAWEEDFS_SHA256,
	TEST_SEAWEEDFS_VERSION,
	verifyArchive,
} from './seaweedfs';

describe('the SeaweedFS asset', () => {
	test('names the release asset for each platform the release ships', () => {
		expect(assetFor('linux', 'x64')).toBe('linux_amd64.tar.gz');
		expect(assetFor('linux', 'arm64')).toBe('linux_arm64.tar.gz');
		expect(assetFor('linux', 'arm')).toBe('linux_arm.tar.gz');
		expect(assetFor('darwin', 'arm64')).toBe('darwin_arm64.tar.gz');
		expect(assetFor('darwin', 'x64')).toBe('darwin_amd64.tar.gz');
	});

	test('says so for a platform the release does not ship', () => {
		expect(() => assetFor('win32', 'x64')).toThrow('No SeaweedFS binary');
		expect(() => assetFor('darwin', 'arm')).toThrow('WEED_BIN');
	});

	test('pins a SHA-256 for every asset assetFor can name', () => {
		for (const platform of ['linux', 'darwin', 'freebsd', 'openbsd']) {
			for (const arch of ['x64', 'arm64', 'arm']) {
				let asset: string;
				try {
					asset = assetFor(platform, arch);
				} catch {
					continue;
				}
				expect(TEST_SEAWEEDFS_SHA256[asset]).toMatch(/^[0-9a-f]{64}$/);
			}
		}
	});

	test('refuses a download whose SHA-256 is not the pinned one', () => {
		const wrong = new TextEncoder().encode('not the release');
		expect(() => verifyArchive('linux_amd64.tar.gz', wrong)).toThrow(
			`SeaweedFS ${TEST_SEAWEEDFS_VERSION} linux_amd64.tar.gz has SHA-256`,
		);
		expect(() => verifyArchive('linux_amd64.tar.gz', wrong)).toThrow(
			'refusing to run it',
		);
	});

	test('refuses an asset it pins nothing for', () => {
		expect(() => verifyArchive('plan9_amd64.tar.gz', new Uint8Array())).toThrow(
			'No pinned SHA-256',
		);
	});
});

describe('the cache', () => {
	test('defaults to node_modules/.cache/@nxgt/s3/seaweedfs under the nearest node_modules', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'weed-cache-'));
		try {
			await mkdir(join(dir, 'node_modules'));
			await mkdir(join(dir, 'a', 'b'), { recursive: true });
			expect(defaultCacheDir(join(dir, 'a', 'b'))).toEndWith(
				'/node_modules/.cache/@nxgt/s3/seaweedfs',
			);
			expect(defaultCacheDir(join(dir, 'a', 'b'))).toStartWith(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('finds a binary already in cacheDir, downloading nothing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'weed-cache-'));
		const before = process.env['WEED_BIN'];
		delete process.env['WEED_BIN'];
		try {
			const binary = join(dir, TEST_SEAWEEDFS_VERSION, 'weed');
			await Bun.write(binary, '#!/bin/sh\n');
			expect(await seaweedfsBinary({ cacheDir: dir })).toBe(binary);
		} finally {
			if (before !== undefined) process.env['WEED_BIN'] = before;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('the download', () => {
	/** A gzip tar holding one executable `weed`, and its SHA-256. */
	async function archiveOf(script: string) {
		const dir = await mkdtemp(join(tmpdir(), 'weed-archive-'));
		try {
			await Bun.write(join(dir, 'weed'), script);
			await Bun.$`chmod +x ${join(dir, 'weed')}`;
			await Bun.$`tar czf ${join(dir, 'a.tar.gz')} -C ${dir} weed`.quiet();
			const bytes = new Uint8Array(
				await Bun.file(join(dir, 'a.tar.gz')).arrayBuffer(),
			);
			return {
				bytes,
				sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
			};
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	const serving = (bytes: Uint8Array, status = 200) =>
		(async () =>
			new Response(Buffer.from(bytes), { status })) as unknown as typeof fetch;

	test('unpacks a checked archive, renames it into place and leaves no staging', async () => {
		const { bytes, sha256 } = await archiveOf('#!/bin/sh\necho version\n');
		const cache = await mkdtemp(join(tmpdir(), 'weed-dl-'));
		try {
			const target = join(cache, TEST_SEAWEEDFS_VERSION, 'weed');
			await download('linux_amd64.tar.gz', target, {
				fetch: serving(bytes),
				sha256,
			});
			expect(await Bun.file(target).text()).toContain('echo version');
			expect(await readdir(join(cache, TEST_SEAWEEDFS_VERSION))).toEqual([
				'weed',
			]);
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	});

	test('refuses an archive that does not match, and caches nothing', async () => {
		const { bytes } = await archiveOf('#!/bin/sh\n');
		const cache = await mkdtemp(join(tmpdir(), 'weed-dl-'));
		try {
			const target = join(cache, 'v', 'weed');
			await expect(
				download('linux_amd64.tar.gz', target, {
					fetch: serving(bytes),
					sha256: '0'.repeat(64),
				}),
			).rejects.toThrow('refusing to run it');
			expect(await Bun.file(target).exists()).toBe(false);
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	});

	test('refuses a binary that does not run, and cleans up', async () => {
		const { bytes, sha256 } = await archiveOf(
			'#!/bin/sh\necho broken >&2\nexit 3\n',
		);
		const cache = await mkdtemp(join(tmpdir(), 'weed-dl-'));
		try {
			const target = join(cache, 'v', 'weed');
			await expect(
				download('linux_amd64.tar.gz', target, {
					fetch: serving(bytes),
					sha256,
				}),
			).rejects.toThrow('does not run: broken');
			expect(await readdir(join(cache, 'v'))).toEqual([]);
		} finally {
			await rm(cache, { recursive: true, force: true });
		}
	});

	test('reports an answer that is not 200', async () => {
		await expect(
			download('linux_amd64.tar.gz', '/nowhere/v/weed', {
				fetch: serving(new Uint8Array(), 404),
			}),
		).rejects.toThrow('answered 404');
	});
});

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assetFor,
	cachedBinaryPath,
	ensureSeaweedfs,
	SEAWEEDFS_VERSION,
} from './seaweedfs';

/** Runs `fn` with `$WEED_BIN` set, and puts the environment back. */
async function withBin(value: string, fn: () => Promise<void>): Promise<void> {
	const before = process.env.WEED_BIN;
	process.env.WEED_BIN = value;
	try {
		await fn();
	} finally {
		if (before === undefined) delete process.env.WEED_BIN;
		else process.env.WEED_BIN = before;
	}
}

describe('the SeaweedFS binary', () => {
	test('names the release asset for each platform the release ships', () => {
		expect(assetFor('linux', 'x64')).toBe('linux_amd64.tar.gz');
		expect(assetFor('linux', 'arm64')).toBe('linux_arm64.tar.gz');
		expect(assetFor('linux', 'arm')).toBe('linux_arm.tar.gz');
		expect(assetFor('darwin', 'arm64')).toBe('darwin_arm64.tar.gz');
		expect(assetFor('darwin', 'x64')).toBe('darwin_amd64.tar.gz');
	});

	test('says so for a platform the release does not ship', () => {
		expect(() => assetFor('win32', 'x64')).toThrow('No SeaweedFS binary');
		// The release ships no ARM build for macOS's 32-bit arm.
		expect(() => assetFor('darwin', 'arm')).toThrow('WEED_BIN');
	});

	test('caches under the repository’s .cache, beside the other servers', () => {
		expect(cachedBinaryPath()).toContain(
			`/.cache/seaweedfs/${SEAWEEDFS_VERSION}/weed`,
		);
	});

	test('uses $WEED_BIN when it names one that exists', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'weed-bin-'));
		const binary = join(dir, 'weed');
		try {
			await Bun.write(binary, '#!/bin/sh\necho version 4.47\n');
			await withBin(binary, async () => {
				expect(await ensureSeaweedfs()).toBe(binary);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('says so when WEED_BIN points at nothing', async () => {
		await withBin('/nowhere/weed', async () => {
			await expect(ensureSeaweedfs()).rejects.toThrow('which does not exist');
		});
	});
});

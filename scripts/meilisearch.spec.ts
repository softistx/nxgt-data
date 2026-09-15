import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assetFor,
	cachedBinaryPath,
	ensureMeilisearch,
	MEILISEARCH_VERSION,
} from './meilisearch';

/** Runs `fn` with `$MEILISEARCH_BIN` set, and puts the environment back. */
async function withBin(value: string, fn: () => Promise<void>): Promise<void> {
	const before = process.env.MEILISEARCH_BIN;
	process.env.MEILISEARCH_BIN = value;
	try {
		await fn();
	} finally {
		if (before === undefined) delete process.env.MEILISEARCH_BIN;
		else process.env.MEILISEARCH_BIN = before;
	}
}

describe('the Meilisearch binary', () => {
	test('names the release asset for each platform the release ships', () => {
		expect(assetFor('linux', 'x64')).toBe('meilisearch-linux-amd64');
		expect(assetFor('linux', 'arm64')).toBe('meilisearch-linux-aarch64');
		expect(assetFor('darwin', 'arm64')).toBe('meilisearch-macos-apple-silicon');
	});

	test('points at MEILISEARCH_BIN for a platform with no community build', () => {
		expect(() => assetFor('darwin', 'x64')).toThrow(
			/no community build for Intel macOS.*MEILISEARCH_BIN/,
		);
		expect(() => assetFor('win32', 'x64')).toThrow(
			'No Meilisearch binary for win32/x64: install one and set MEILISEARCH_BIN to its path.',
		);
	});

	test('caches it per version, under the git-ignored .cache', () => {
		expect(cachedBinaryPath()).toEndWith(
			`/.cache/meilisearch/${MEILISEARCH_VERSION}/meilisearch`,
		);
		expect(cachedBinaryPath('v9.9.9')).toEndWith(
			'/.cache/meilisearch/v9.9.9/meilisearch',
		);
	});

	test('takes MEILISEARCH_BIN as it is, and downloads nothing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'meilisearch-bin-'));
		const binary = join(dir, 'meilisearch');
		try {
			await Bun.write(binary, '#!/bin/sh\necho v1.53.2\n');
			await withBin(binary, async () => {
				expect(await ensureMeilisearch()).toBe(binary);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('says so when MEILISEARCH_BIN points at nothing', async () => {
		await withBin('/nowhere/meilisearch', async () => {
			expect(ensureMeilisearch()).rejects.toThrow(
				'MEILISEARCH_BIN is /nowhere/meilisearch, which does not exist',
			);
		});
	});
});

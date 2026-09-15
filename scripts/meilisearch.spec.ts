import { describe, expect, test } from 'bun:test';
import { assetFor, cachedBinaryPath, MEILISEARCH_VERSION } from './meilisearch';

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
	});
});

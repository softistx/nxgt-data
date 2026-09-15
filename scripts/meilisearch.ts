#!/usr/bin/env bun
/**
 * Downloads the official Meilisearch binary for this machine, once, and prints
 * where it is.
 *
 * `@nxgt/meilisearch`'s specs run against a real Meilisearch, started per spec
 * file on a free port, with no Docker: this is where its binary comes from.
 * It is the community build from the GitHub releases of
 * meilisearch/meilisearch, pinned to `MEILISEARCH_VERSION`, and cached under
 * `.cache/meilisearch/<version>/meilisearch`, which git ignores. A second run
 * finds it there and downloads nothing.
 *
 * `$MEILISEARCH_BIN`, when set, names a binary to use instead: one installed
 * some other way, or a build for a platform the releases no longer ship.
 *
 * Raise the version here, and the cache key follows: CI keys its cache on the
 * hash of this file.
 */

import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

/** The Meilisearch release the specs run against. */
export const MEILISEARCH_VERSION = 'v1.53.2';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * The release asset for a platform and an architecture, as `process.platform`
 * and `process.arch` name them. Throws for one the release does not ship.
 */
export function assetFor(platform: string, arch: string): string {
	if (platform === 'linux' && arch === 'x64') return 'meilisearch-linux-amd64';
	if (platform === 'linux' && arch === 'arm64') {
		return 'meilisearch-linux-aarch64';
	}
	if (platform === 'darwin' && arch === 'arm64') {
		return 'meilisearch-macos-apple-silicon';
	}
	// The community build for Intel Macs stopped after v1.50; only the
	// enterprise one, under another license, is still published.
	const hint =
		platform === 'darwin' && arch === 'x64'
			? `Meilisearch ${MEILISEARCH_VERSION} ships no community build for Intel macOS. `
			: '';
	throw new Error(
		`${hint}No Meilisearch binary for ${platform}/${arch}: install one and ` +
			'set MEILISEARCH_BIN to its path.',
	);
}

/** Where the binary for `version` is cached. */
export function cachedBinaryPath(version = MEILISEARCH_VERSION): string {
	return join(ROOT, '.cache', 'meilisearch', version, 'meilisearch');
}

/**
 * The path of a Meilisearch binary that runs: `$MEILISEARCH_BIN`, the cached
 * one, or one downloaded now.
 */
export async function ensureMeilisearch(): Promise<string> {
	const override = process.env.MEILISEARCH_BIN;
	if (override) {
		if (!(await Bun.file(override).exists())) {
			throw new Error(`MEILISEARCH_BIN is ${override}, which does not exist`);
		}
		return override;
	}

	const target = cachedBinaryPath();
	if (await Bun.file(target).exists()) return target;

	const asset = assetFor(process.platform, process.arch);
	const url = `https://github.com/meilisearch/meilisearch/releases/download/${MEILISEARCH_VERSION}/${asset}`;
	console.error(`Downloading Meilisearch ${MEILISEARCH_VERSION} (${asset})…`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`GET ${url} answered ${response.status}`);
	}

	// Written next to its final name, then renamed: two spec runs starting at
	// once never see half a binary.
	await mkdir(dirname(target), { recursive: true });
	const partial = `${target}.${process.pid}.part`;
	try {
		await Bun.write(partial, response);
		await chmod(partial, 0o755);
		const version = await $`${partial} --version`.quiet().nothrow();
		if (version.exitCode !== 0) {
			throw new Error(
				`the downloaded ${asset} does not run: ${version.stderr.toString().trim()}`,
			);
		}
		await rename(partial, target);
	} finally {
		await rm(partial, { force: true });
	}
	return target;
}

if (import.meta.main) {
	console.log(await ensureMeilisearch());
}

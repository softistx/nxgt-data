#!/usr/bin/env bun
/**
 * Downloads the SeaweedFS `weed` binary for this machine, once, and prints
 * where it is.
 *
 * `@nxgt/s3`'s specs run against a real S3 API, started per spec file on free
 * ports, with no Docker: this is where its server comes from. SeaweedFS is
 * that server because **MinIO no longer is** — measured on 2026-09-18,
 * `dl.min.io` answers `410 Gone` ("The open-source MinIO Server, MinIO Client
 * and MinIO KES projects are archived and no longer maintained") and the
 * latest GitHub release carries no binary at all. SeaweedFS still publishes
 * one per platform, and `weed server -s3` serves the S3 API that
 * `Bun.S3Client` talks to.
 *
 * The release archive is cached under `.cache/seaweedfs/<version>/weed`,
 * which git ignores. A second run finds it there and downloads nothing.
 *
 * `$WEED_BIN`, when set, names a binary to use instead: one installed some
 * other way, or a build for a platform the releases do not ship.
 *
 * Raise the version here, and the cache key follows: CI keys its cache on the
 * hash of this file.
 */

import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

/** The SeaweedFS release the specs run against. */
export const SEAWEEDFS_VERSION = '4.47';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * The release asset for a platform and an architecture, as `process.platform`
 * and `process.arch` name them. Throws for one the release does not ship.
 */
export function assetFor(platform: string, arch: string): string {
	const platforms: Record<string, string> = {
		linux: 'linux',
		darwin: 'darwin',
		freebsd: 'freebsd',
		openbsd: 'openbsd',
	};
	const arches: Record<string, string> = {
		x64: 'amd64',
		arm64: 'arm64',
		arm: 'arm',
	};
	const os = platforms[platform];
	const cpu = arches[arch];
	// The release ships no darwin/arm and no `arm` outside linux and the BSDs.
	if (!os || !cpu || (cpu === 'arm' && os === 'darwin')) {
		throw new Error(
			`No SeaweedFS binary for ${platform}/${arch}: install one and set ` +
				'WEED_BIN to its path.',
		);
	}
	return `${os}_${cpu}.tar.gz`;
}

/** Where the binary for `version` is cached. */
export function cachedBinaryPath(version = SEAWEEDFS_VERSION): string {
	return join(ROOT, '.cache', 'seaweedfs', version, 'weed');
}

/**
 * The path of a `weed` binary that runs: `$WEED_BIN`, the cached one, or one
 * downloaded now.
 */
export async function ensureSeaweedfs(): Promise<string> {
	const override = process.env.WEED_BIN;
	if (override) {
		if (!(await Bun.file(override).exists())) {
			throw new Error(`WEED_BIN is ${override}, which does not exist`);
		}
		return override;
	}

	const target = cachedBinaryPath();
	if (await Bun.file(target).exists()) return target;

	const asset = assetFor(process.platform, process.arch);
	const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${SEAWEEDFS_VERSION}/${asset}`;
	console.error(`Downloading SeaweedFS ${SEAWEEDFS_VERSION} (${asset})…`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`GET ${url} answered ${response.status}`);
	}

	// Unpacked into a directory of this process's own, then renamed: two spec
	// runs starting at once never see half a binary. The archive holds one
	// file, `weed`.
	await mkdir(dirname(target), { recursive: true });
	const staging = `${target}.${process.pid}.part`;
	const archive = `${staging}.tar.gz`;
	try {
		await Bun.write(archive, response);
		await mkdir(staging, { recursive: true });
		const untar = await $`tar xzf ${archive} -C ${staging}`.quiet().nothrow();
		if (untar.exitCode !== 0) {
			throw new Error(
				`unpacking ${asset} failed: ${untar.stderr.toString().trim()}`,
			);
		}
		const unpacked = join(staging, 'weed');
		await chmod(unpacked, 0o755);
		const version = await $`${unpacked} version`.quiet().nothrow();
		if (version.exitCode !== 0) {
			throw new Error(
				`the downloaded ${asset} does not run: ${version.stderr.toString().trim()}`,
			);
		}
		await rename(unpacked, target);
	} finally {
		await rm(archive, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
	return target;
}

if (import.meta.main) {
	console.log(await ensureSeaweedfs());
}

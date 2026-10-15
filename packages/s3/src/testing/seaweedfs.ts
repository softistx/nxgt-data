/**
 * The SeaweedFS `weed` binary `@nxgt/s3/testing` starts: where it comes from,
 * and how it is checked.
 *
 * SeaweedFS is the server because **MinIO no longer is** — measured on
 * 2026-09-18, `dl.min.io` answers `410 Gone` and the latest GitHub release
 * carries no binary at all. SeaweedFS publishes one per platform, and
 * `weed server -s3` serves the S3 API that `Bun.S3Client` talks to.
 *
 * The binary is, in order: the `binary` option, `$WEED_BIN`, the cached one,
 * or one downloaded now into the cache and checked against the SHA-256 pinned
 * below. A download that does not match is refused and never cached.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { $, CryptoHasher } from 'bun';

/** The SeaweedFS release the test server runs: the one place it is pinned. */
export const TEST_SEAWEEDFS_VERSION = '4.47';

/**
 * The SHA-256 of each release asset of `TEST_SEAWEEDFS_VERSION`, computed from
 * the downloaded assets (and equal to the digest GitHub shows for them).
 * Raise the version and this table together.
 */
export const TEST_SEAWEEDFS_SHA256: Readonly<Record<string, string>> = {
	'darwin_amd64.tar.gz':
		'45475223d51b78efb413cb7a29c005c7e9e0cc3f0dfe13d10413e7f85c479b6a',
	'darwin_arm64.tar.gz':
		'3ad466db33e83d0b103f90a06997feeb1cc42fd536e6cbdcdded975778f64fda',
	'freebsd_amd64.tar.gz':
		'5a8595de1ccf6f459457b46334ddd4d4acb0d9b09d6bcea1e4b6e3d0c3e05053',
	'freebsd_arm.tar.gz':
		'5aa419209657396380102e8d11f2d66aadb40a1aeb1f224f908b4c4aea3685d1',
	'freebsd_arm64.tar.gz':
		'08ddd46893384d9805c3a7ade74ce89a32d3c07104c717a73e456284e3511130',
	'linux_amd64.tar.gz':
		'31fb804858885f9e7f18b6d3b1da09e824baac3e6a55b5a62c3c4c77e6ed6d7d',
	'linux_arm.tar.gz':
		'ac302e29ea7d6f23b4ccd74462d49161970d3205a5af58caab9d023a854b3357',
	'linux_arm64.tar.gz':
		'ba5c9def9ff98f78becdf309a50a9f906922f6383a7c4c772d01ede3cc012e16',
	'openbsd_amd64.tar.gz':
		'8414bedaf0d3868e7901906751b91170956fea15d0e1667fb542fc05f3d59ec4',
	'openbsd_arm.tar.gz':
		'83e5bc7a861846d35d8ac9045e7fcbc82160c804689965a295e819e8cf66e7bf',
	'openbsd_arm64.tar.gz':
		'607333bf22c5b6945300fcea5d985ec32f5349f936eb3221b963fb72df13e9d1',
};

export interface SeaweedfsOptions {
	/** A `weed` binary to use. Wins over `$WEED_BIN` and the cache. */
	binary?: string;
	/**
	 * Where the download is cached; the binary lives in `<cacheDir>/<version>/weed`.
	 * Defaults to `node_modules/.cache/@nxgt/s3/seaweedfs`, found from the
	 * working directory.
	 */
	cacheDir?: string;
}

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

/**
 * Refuses an archive whose SHA-256 is not the pinned one. The message names
 * both, so a tampered download and a stale table read differently.
 */
export function verifyArchive(
	asset: string,
	bytes: Uint8Array,
	expected = TEST_SEAWEEDFS_SHA256[asset],
): void {
	if (!expected) {
		throw new Error(
			`No pinned SHA-256 for SeaweedFS ${TEST_SEAWEEDFS_VERSION} ${asset}: ` +
				'refusing to run an unchecked download.',
		);
	}
	const actual = new CryptoHasher('sha256').update(bytes).digest('hex');
	if (actual !== expected) {
		throw new Error(
			`SeaweedFS ${TEST_SEAWEEDFS_VERSION} ${asset} has SHA-256 ${actual}, ` +
				`expected ${expected}: refusing to run it.`,
		);
	}
}

/** `node_modules/.cache/@nxgt/s3/seaweedfs` under the nearest `node_modules`. */
export function defaultCacheDir(cwd = process.cwd()): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, 'node_modules'))) break;
		const parent = dirname(dir);
		if (parent === dir) {
			dir = resolve(cwd);
			break;
		}
		dir = parent;
	}
	return join(dir, 'node_modules', '.cache', '@nxgt', 's3', 'seaweedfs');
}

/** What `download` takes from outside; the specs replace both. */
export interface DownloadDeps {
	fetch?: typeof fetch;
	/** The SHA-256 the archive must have. Defaults to the pinned one. */
	sha256?: string;
}

export async function download(
	asset: string,
	target: string,
	deps: DownloadDeps = {},
): Promise<void> {
	const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${TEST_SEAWEEDFS_VERSION}/${asset}`;
	process.emitWarning(
		`Downloading SeaweedFS ${TEST_SEAWEEDFS_VERSION} (${asset}) into ${dirname(target)}`,
		{ code: 'NxgtS3Download' },
	);
	const response = await (deps.fetch ?? fetch)(url);
	if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	verifyArchive(asset, bytes, deps.sha256 ?? TEST_SEAWEEDFS_SHA256[asset]);

	// Unpacked into a directory of this process's own, then renamed: two runs
	// starting at once never see half a binary. The archive holds one file.
	await mkdir(dirname(target), { recursive: true });
	const staging = `${target}.${process.pid}.part`;
	const archive = `${staging}.tar.gz`;
	try {
		await Bun.write(archive, bytes);
		await mkdir(staging, { recursive: true });
		const untar = await $`tar xzf ${archive} -C ${staging}`.quiet().nothrow();
		if (untar.exitCode !== 0) {
			throw new Error(
				`unpacking ${asset} failed: ${untar.stderr.toString().trim()}`,
			);
		}
		const unpacked = join(staging, 'weed');
		await chmod(unpacked, 0o755);
		const ran = await $`${unpacked} version`.quiet().nothrow();
		if (ran.exitCode !== 0) {
			throw new Error(
				`the downloaded ${asset} does not run: ${ran.stderr.toString().trim()}`,
			);
		}
		await rename(unpacked, target);
	} finally {
		await rm(archive, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * The path of a `weed` binary that runs: the `binary` option, `$WEED_BIN`, the
 * cached one, or one downloaded now and checked against its pinned SHA-256.
 */
export async function seaweedfsBinary(
	options: SeaweedfsOptions = {},
): Promise<string> {
	if (options.binary) {
		if (!(await Bun.file(options.binary).exists())) {
			throw new Error(`binary is ${options.binary}, which does not exist`);
		}
		return options.binary;
	}
	const override = process.env['WEED_BIN'];
	if (override) {
		if (!(await Bun.file(override).exists())) {
			throw new Error(`WEED_BIN is ${override}, which does not exist`);
		}
		return override;
	}

	const cacheDir = options.cacheDir ?? defaultCacheDir();
	const target = join(cacheDir, TEST_SEAWEEDFS_VERSION, 'weed');
	if (await Bun.file(target).exists()) return target;
	await download(assetFor(process.platform, process.arch), target);
	return target;
}

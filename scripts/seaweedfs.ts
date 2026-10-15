#!/usr/bin/env bun
/**
 * Downloads the SeaweedFS `weed` binary for this machine, once, and prints
 * where it is.
 *
 * `@nxgt/s3`'s specs — and `@nxgt/backup`'s — run against a real S3 API,
 * started per spec file on free ports, with no Docker. The server and the
 * binary's download live in `@nxgt/s3/testing`
 * (`packages/s3/src/testing/seaweedfs.ts`: the pinned version, the SHA-256 of
 * each asset, and why SeaweedFS and not MinIO). This script only runs that
 * download **before** the specs, so it is not inside a hook's timeout, into
 * the repository's `.cache/seaweedfs`, which git ignores.
 *
 * `$WEED_BIN`, when set, names a binary to use instead: one installed some
 * other way, or a build for a platform the releases do not ship. Its branch is
 * covered by `scripts/seaweedfs.spec.ts`.
 *
 * Raise the version in `packages/s3/src/testing/seaweedfs.ts`: CI keys its
 * cache on the hash of that file and of this one.
 */

import { join } from 'node:path';
import { seaweedfsBinary } from '../packages/s3/src/testing/seaweedfs';

/** The repository's cache, where the specs and CI look for the binary. */
export const SEAWEEDFS_CACHE = join(
	new URL('..', import.meta.url).pathname,
	'.cache',
	'seaweedfs',
);

/** The path of a `weed` that runs: `$WEED_BIN`, the cached one, or a download. */
export function ensureSeaweedfs(): Promise<string> {
	return seaweedfsBinary({ cacheDir: SEAWEEDFS_CACHE });
}

if (import.meta.main) {
	console.log(await ensureSeaweedfs());
}

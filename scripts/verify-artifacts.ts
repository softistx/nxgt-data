#!/usr/bin/env bun

/**
 * Packs every package, installs the tarballs the way a consumer does, and
 * imports every subpath each one declares.
 *
 * This exists because `bun run build` exiting 0 proves almost nothing here.
 * The specs import each sibling's source, so nothing they run loads `dist/`.
 * In nxgt-core, where this script comes from, three defects shipped past a
 * green build, each throwing the instant its package was imported, and all
 * three invisible to `bun run build`, `bun typecheck` and `biome`.
 * Only importing the built artifact catches that class of failure. A bin is
 * the same story, so each one declared is run from `node_modules/.bin` with
 * `--help`: that proves the link, the `#!` line and the mode together.
 *
 * The install uses `overrides` so the packages resolve to each other's
 * tarballs rather than to whatever is on the registry — otherwise this would
 * silently verify the *published* versions instead of the working tree.
 * Everything else resolves from the registry the way a consumer's install
 * does. Optional peers are installed too, the way a
 * consumer who uses the subpath that needs one would.
 *
 * Each check lives in `scripts/artifacts/`, one module per responsibility;
 * this file only runs them in order and stops at the first that fails.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classesDefinedOnce } from './artifacts/classes';
import { installAsConsumer, type Packed, pack } from './artifacts/install';
import { binsRun, subpathsLoad } from './artifacts/load';
import { manifestProblems } from './artifacts/manifest';
import { type Pkg, readPackages } from './artifacts/packages';
import { staleBuilds } from './artifacts/stale';

async function builtFresh(packages: readonly Pkg[]): Promise<boolean> {
	const stale = await staleBuilds([...packages]);
	if (stale.length === 0) return true;
	console.error('This would verify a stale build, not the working tree:\n');
	for (const one of stale) console.error(`  ${one}`);
	console.error(
		'\nRun `bun run build` first. This script packs `dist/`, which is\n' +
			'gitignored, so a stale one reports failures the source does not have —\n' +
			'and they look like environment problems, not build problems.',
	);
	return false;
}

async function tarballsSound(
	packages: readonly Pkg[],
	{ tarballs }: Packed,
): Promise<boolean> {
	const versions = Object.fromEntries(packages.map((p) => [p.name, p.version]));
	const problems = await manifestProblems(tarballs, versions);
	if (problems.length === 0) return true;
	console.error('\nA published tarball would break a consumer:\n');
	for (const problem of problems) console.error(`  ${problem}`);
	console.error(
		'\nA `link:` or `file:` no consumer can resolve, a required peer that is\n' +
			'on no registry, a sibling range that leaves out the sibling beside\n' +
			'it, an exact pin on a sibling, a package that lists itself, a\n' +
			'license other than MIT or no LICENSE shipped, or test code shipped.\n' +
			'See AGENTS.md.',
	);
	return false;
}

async function main(): Promise<boolean> {
	const packages = await readPackages();
	if (!(await builtFresh(packages))) return false;

	const workdir = await mkdtemp(join(tmpdir(), 'nxgt-data-verify-'));
	try {
		const packed = await pack(workdir, packages);
		return (
			(await tarballsSound(packages, packed)) &&
			(await installAsConsumer(workdir, packed)) &&
			(await subpathsLoad(workdir, packages)) &&
			(await classesDefinedOnce(workdir, packages)) &&
			(await binsRun(workdir, packages))
		);
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}

if (import.meta.main && !(await main())) {
	process.exit(1);
}

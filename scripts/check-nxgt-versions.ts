#!/usr/bin/env bun
/**
 * Lists every `@nxgt/*` devDependency whose locked version is behind npm's
 * `latest`.
 *
 * Here those are the example's: `examples/hono-api` builds its routes with
 * `@nxgt/openapi-codegen` and binds them with `@nxgt/openapi-hono`, both from
 * nxgt-http, and its specs run only the versions `bun.lock` holds. A new
 * release upstream is therefore used by nobody here until someone bumps the
 * lock. This check is what makes that someone the `nxgt-versions` workflow,
 * weekly, instead of memory.
 *
 * Copied from nxgt-janus, where the packages peer the nxgt libraries they wrap
 * by range. What differs: this copy reads every workspace the root
 * `package.json` names — `examples/*` as well as `packages/*` — so a
 * directory is named from the root (`examples/hono-api`), not from
 * `packages/`; and a private workspace's `dependencies` count as
 * devDependencies, since nobody installs it.
 *
 * Dependabot would do it, but not here: its Bun updater reads `bun.lock` up to
 * `lockfileVersion` 1 and this one, written by Bun 1.4.2, is 2.
 *
 * Exits 0 when everything is current, 1 when something is behind, 2 when it
 * could not tell — a registry that does not answer is a failure, never
 * "current".
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SCOPE = '@nxgt/';

export interface Manifest {
	/** The package's directory, from the root: `packages/mongo`. */
	readonly dir: string;
	readonly name: string;
	readonly devDependencies: Readonly<Record<string, string>>;
}

/** An `@nxgt/*` package from outside this repository, as the specs run it. */
export interface Tracked {
	readonly name: string;
	/** The directories whose devDependencies name it. */
	readonly dirs: readonly string[];
	/** Every version `bun.lock` resolves it to; empty when it holds none. */
	readonly locked: readonly string[];
}

export interface Behind {
	readonly name: string;
	readonly dirs: readonly string[];
	/** The oldest locked version, or `null` when `bun.lock` holds none. */
	readonly locked: string | null;
	readonly latest: string;
}

/**
 * The `@nxgt/*` devDependencies that are not a sibling of this repository,
 * with the versions `bun.lock`'s `packages` resolves them to. Pure.
 */
export function tracked(
	manifests: readonly Manifest[],
	lockPackages: Readonly<Record<string, unknown>>,
): Tracked[] {
	const siblings = new Set(manifests.map((one) => one.name));
	const dirs = new Map<string, string[]>();
	for (const { dir, devDependencies } of manifests) {
		for (const [name, spec] of Object.entries(devDependencies)) {
			if (!name.startsWith(SCOPE) || siblings.has(name)) continue;
			// A sibling the list above does not hold is still a workspace.
			if (spec.startsWith('workspace:')) continue;
			dirs.set(name, [...(dirs.get(name) ?? []), dir]);
		}
	}
	const locked = new Map<string, Set<string>>();
	for (const entry of Object.values(lockPackages)) {
		const ident = Array.isArray(entry) ? entry[0] : undefined;
		if (typeof ident !== 'string') continue;
		const at = ident.lastIndexOf('@');
		if (at <= 0) continue;
		const name = ident.slice(0, at);
		const version = ident.slice(at + 1);
		// `workspace:packages/mongo`, a tarball or a git URL is not a release.
		if (!dirs.has(name) || !/^\d+\.\d+\.\d+/.test(version)) continue;
		locked.set(name, (locked.get(name) ?? new Set()).add(version));
	}
	return [...dirs]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, where]) => ({
			name,
			dirs: where.sort(),
			locked: [...(locked.get(name) ?? [])].sort(Bun.semver.order),
		}));
}

/**
 * The tracked packages whose oldest locked version is below `latest`, or that
 * `bun.lock` does not hold at all. Pure. A package missing from `latest`
 * throws: not knowing is not "current".
 */
export function behind(
	packages: readonly Tracked[],
	latest: ReadonlyMap<string, string>,
): Behind[] {
	return packages.flatMap(({ name, dirs, locked }) => {
		const newest = latest.get(name);
		if (newest === undefined) {
			throw new Error(`check-nxgt-versions: no latest version for ${name}`);
		}
		const oldest = locked[0] ?? null;
		return oldest === null || Bun.semver.order(oldest, newest) < 0
			? [{ name, dirs, locked: oldest, latest: newest }]
			: [];
	});
}

/** One line per package behind, as the terminal and the issue both read it. */
export function report(found: readonly Behind[]): string[] {
	return found.map(
		({ name, dirs, locked, latest }) =>
			`${name}: ${locked ?? 'not in bun.lock'} → ${latest} (${dirs.join(', ')})`,
	);
}

/** npm's `latest` dist-tag for a package. Throws on anything but an answer. */
export async function latestOf(name: string): Promise<string> {
	const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`check-nxgt-versions: the registry answered ${response.status} for ${name}`,
		);
	}
	const { version } = (await response.json()) as { version?: unknown };
	if (typeof version !== 'string') {
		throw new Error(`check-nxgt-versions: no version in ${name}'s latest`);
	}
	return version;
}

/**
 * The folder a workspace glob names. Pure. Only `<folder>/*` is read: any
 * other glob throws, since skipping what it names would report "current".
 */
export function folderOf(glob: string): string {
	if (!/^[^*]+\/\*$/.test(glob)) {
		throw new Error(
			`check-nxgt-versions: cannot read the workspace ${glob}, only <folder>/*`,
		);
	}
	return glob.slice(0, -2);
}

/**
 * A workspace's manifest, as `tracked` reads it. Pure. A private one — an
 * example — is installed by nobody, so its `dependencies` are development
 * inputs too, and count as devDependencies.
 */
export function manifestOf(
	dir: string,
	json: {
		name?: unknown;
		private?: unknown;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	},
): Manifest {
	return {
		dir,
		name: String(json.name),
		devDependencies: {
			...(json.private === true ? json.dependencies : {}),
			...json.devDependencies,
		},
	};
}

/**
 * The manifests of every workspace the root `package.json` names, and
 * `bun.lock`'s packages.
 */
export async function read(root: string): Promise<{
	manifests: Manifest[];
	lockPackages: Record<string, unknown>;
}> {
	const { workspaces } = (await Bun.file(
		join(root, 'package.json'),
	).json()) as {
		workspaces?: string[];
	};
	const manifests: Manifest[] = [];
	for (const glob of workspaces ?? []) {
		const folder = folderOf(glob);
		for (const name of await readdir(join(root, folder))) {
			const dir = `${folder}/${name}`;
			const file = Bun.file(join(root, dir, 'package.json'));
			if (!(await file.exists())) continue;
			manifests.push(manifestOf(dir, await file.json()));
		}
	}
	const lock = Bun.JSONC.parse(
		await Bun.file(join(root, 'bun.lock')).text(),
	) as { packages?: Record<string, unknown> };
	return { manifests, lockPackages: lock.packages ?? {} };
}

if (import.meta.main) {
	try {
		const { manifests, lockPackages } = await read(ROOT);
		const packages = tracked(manifests, lockPackages);
		const latest = new Map(
			await Promise.all(
				packages.map(async ({ name }) => [name, await latestOf(name)] as const),
			),
		);
		const lines = report(behind(packages, latest));
		if (lines.length === 0) {
			console.log(`${packages.length} @nxgt/* devDependencies, all current`);
			process.exit(0);
		}
		for (const line of lines) console.log(`- ${line}`);
		process.exit(1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	}
}

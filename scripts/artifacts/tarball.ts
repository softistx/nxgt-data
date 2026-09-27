import { $ } from 'bun';

export type Tarball = {
	manifest: Record<string, unknown>;
	/** Every path in the tarball, `package/` prefix included. */
	entries: string[];
};

/** A packed tarball's `package.json` and the list of what it holds. */
export async function readTarball(tgz: string): Promise<Tarball> {
	const raw = await $`tar -xzOf ${tgz} package/package.json`.quiet().text();
	const listing = await $`tar -tzf ${tgz}`.quiet().text();
	return {
		manifest: JSON.parse(raw),
		entries: listing.split('\n').filter(Boolean),
	};
}

/** Every check on what one tarball holds, as opposed to what it declares. */
export function tarballProblems({ manifest, entries }: Tarball): string[] {
	return [...licenseProblems(manifest, entries)];
}

/** A license other than MIT, or no `LICENSE` among the tarball's entries. */
export function licenseProblems(
	manifest: Record<string, unknown>,
	entries: readonly string[],
): string[] {
	const problems: string[] = [];
	if (manifest.license !== 'MIT') {
		problems.push(`${manifest.name}: license is ${manifest.license}, not MIT`);
	}
	if (!entries.includes('package/LICENSE')) {
		problems.push(`${manifest.name}: the tarball has no LICENSE`);
	}
	return problems;
}

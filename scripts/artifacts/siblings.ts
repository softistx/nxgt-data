/**
 * Whether each packed package asks for **exactly** the sibling range its
 * `workspace:` spec produces, given the version of that sibling in the
 * workspace.
 *
 * `bun pm pack` turns `workspace:^` into `^<version>`, and it reads the
 * version **from `bun.lock`**, not from the sibling's `package.json`. After
 * `changeset version` bumps the manifests, the lockfile keeps the old numbers
 * until something runs `bun install`, and `bun install --frozen-lockfile`
 * does not notice. `@nxgt/mongo-meilisearch` 0.1.0 went out asking for
 * `@nxgt/mongo@^0.10.0` beside 0.11.0, and nxgt-telemetry's integrations 0.2.0
 * for `@nxgt/telemetry@^0.1.0` beside 0.2.0: a consumer got the older sibling.
 *
 * The comparison is exact rather than "does the sibling satisfy the range",
 * for two reasons measured on Bun 1.4.2:
 *
 *   - a stale lock *within* one minor — lock 0.2.0, manifest 0.2.1 — packs
 *     `^0.2.0`, which 0.2.1 satisfies, while the package may use an API only
 *     0.2.1 has: the lower bound lets a consumer keep 0.2.0;
 *   - `Bun.semver.satisfies` answers `true` for a range that is not a range at
 *     all: `'garbage!!'`, `'latest'`, `''`.
 *
 * A sibling the repository writes as a plain range keeps the looser check,
 * since there is no spec to compare with: the range must still let in the
 * version beside it. A `workspace:` the pack left unresolved is the manifest
 * check's to report, so it is reported once.
 *
 * Pure, and typed rather than indexed, so every repository's
 * `scripts/artifacts/` can take this file byte for byte.
 */

/** A package's manifest, as packed or as it is in the repository. */
export interface SiblingManifest {
	readonly name: string;
	readonly version: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** The fields a consumer's install resolves. */
const INSTALLED_FIELDS = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

/**
 * What `bun pm pack` must turn a `workspace:` spec into, given the sibling's
 * version; `undefined` for a spec that is not a `workspace:` one.
 */
export function expectedRange(
	spec: string,
	version: string,
): string | undefined {
	switch (spec) {
		case 'workspace:^':
			return `^${version}`;
		case 'workspace:~':
			return `~${version}`;
		case 'workspace:*':
			return version;
		default:
			return spec.startsWith('workspace:')
				? spec.slice('workspace:'.length)
				: undefined;
	}
}

/**
 * @param packed the manifests as they are in the tarballs
 * @param sources the same packages' `package.json` as they are in the
 *   workspace, which is where the `workspace:` specs and the versions being
 *   released still are
 */
export function siblingRangeProblems(
	packed: readonly SiblingManifest[],
	sources: readonly SiblingManifest[],
): string[] {
	const source = new Map(sources.map((m) => [m.name, m]));
	return packed.flatMap((manifest) =>
		INSTALLED_FIELDS.flatMap((field) =>
			Object.entries(manifest[field] ?? {}).flatMap(([dep, range]) => {
				const version = source.get(dep)?.version;
				if (version === undefined || range.startsWith('workspace:')) {
					return [];
				}
				const spec = source.get(manifest.name)?.[field]?.[dep];
				const expected =
					spec === undefined ? undefined : expectedRange(spec, version);
				if (expected !== undefined) {
					return range === expected
						? []
						: [
								`${manifest.name}: ${field}.${dep} = ${range}, but ${spec} ` +
									`beside ${dep}@${version} packs as ${expected}; ` +
									'bun.lock is stale: run `bun install --lockfile-only`',
							];
				}
				return Bun.semver.satisfies(version, range)
					? []
					: [
							`${manifest.name}: ${field}.${dep} = ${range} leaves out ` +
								`${dep}@${version}, the version beside it; run ` +
								'`bun install --lockfile-only`',
						];
			}),
		),
	);
}

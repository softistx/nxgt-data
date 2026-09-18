import type { AnyCollectionDefinition } from '@nxgt/mongo';
import { definitionsOf, isDefinition } from './config/checks';

/** What to scan, and what to read in each file it finds. */
export interface DiscoverOptions {
	/** A glob, relative to `cwd`: `'src/models/*.model.ts'`. */
	glob: string;
	/** Where the glob starts. Default: the process's working directory. */
	cwd?: string;
	/**
	 * The export to read in each file. Default: every export that is a
	 * definition, which is what `import * as collections` gives.
	 */
	export?: string;
}

/**
 * The definitions of the files a glob matches, read at run time.
 *
 * For scripts — a sync or a migration run from the repository — and for
 * nothing else: a glob is read from the file system, so it finds nothing
 * once the application is bundled, and it produces **no types**. An
 * application wires its collections with `import * as collections from
 * './models'`, which a bundler follows and the compiler sees.
 *
 * ```ts
 * import { connectMongo, syncCollections } from '@nxgt/mongo';
 * import { discoverCollections } from '@nxgt/mongo-kit';
 *
 * const mongo = await connectMongo(process.env.MONGO_URI!);
 * const definitions = await discoverCollections({ glob: 'src/**\/*.model.ts' });
 * await syncCollections(mongo.db, definitions);
 * await mongo.close();
 * ```
 *
 * The files are imported, so their top level runs, and the glob is
 * `Bun.Glob`: this one function needs the Bun runtime.
 */
export async function discoverCollections(
	options: DiscoverOptions,
): Promise<AnyCollectionDefinition[]> {
	const { glob, cwd = process.cwd(), export: name } = options;
	if (typeof glob !== 'string' || glob === '') {
		throw new TypeError('discoverCollections: a glob is required');
	}
	const paths = await Array.fromAsync(new Bun.Glob(glob).scan({ cwd }));
	const found: AnyCollectionDefinition[] = [];
	const byName = new Map<string, string>();
	for (const path of paths.sort()) {
		const module = (await import(`${cwd}/${path}`)) as Record<string, unknown>;
		const definitions =
			name === undefined
				? definitionsOf(module)
				: isDefinition(module[name])
					? ([[name, module[name]]] as [string, AnyCollectionDefinition][])
					: [];
		if (name !== undefined && definitions.length === 0) {
			throw new TypeError(
				`discoverCollections: ${path} exports no definition named "${name}"`,
			);
		}
		for (const [, definition] of definitions) {
			const seen = byName.get(definition.name);
			if (seen !== undefined && seen !== path) {
				throw new TypeError(
					`discoverCollections: ${seen} and ${path} both define the collection "${definition.name}"`,
				);
			}
			byName.set(definition.name, path);
			found.push(definition);
		}
	}
	return found;
}

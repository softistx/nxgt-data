/**
 * Runs one script in every package, a package only once every sibling it
 * names — in any dependency field — has run it. `bun run --filter` started
 * dependents beside their dependencies on a clean checkout, measured in
 * alxia, where this comes from: a package type-checked against a sibling with
 * no declarations yet. Here the two bridges and the three kits are the
 * dependents.
 *
 * Packages of one wave run in parallel. `examples/*` are not packages: the
 * root scripts run theirs after this, with `bun run --filter`.
 *
 *   bun run scripts/workspace.ts build
 */
import { join } from 'node:path';
import { $ } from 'bun';
import { ROOT } from './artifacts/packages';

export interface Node {
	readonly name: string;
	readonly dir: string;
	readonly needs: readonly string[];
}

const FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

/** The packages in waves: each wave needs only those before it. */
export function waves(nodes: readonly Node[]): Node[][] {
	const done = new Set<string>();
	const names = new Set(nodes.map((node) => node.name));
	let left = [...nodes];
	const result: Node[][] = [];
	while (left.length > 0) {
		const ready = left.filter((node) =>
			node.needs.every((need) => !names.has(need) || done.has(need)),
		);
		if (ready.length === 0) {
			throw new Error(
				`A dependency cycle between ${left.map((node) => node.name).join(', ')}`,
			);
		}
		for (const node of ready) done.add(node.name);
		left = left.filter((node) => !ready.includes(node));
		result.push(ready);
	}
	return result;
}

async function readNodes(): Promise<Node[]> {
	const nodes: Node[] = [];
	for (const rel of [
		...new Bun.Glob('packages/*/package.json').scanSync(ROOT),
	].sort()) {
		const manifest = await Bun.file(join(ROOT, rel)).json();
		const needs = new Set<string>();
		for (const field of FIELDS) {
			for (const name of Object.keys(manifest[field] ?? {})) needs.add(name);
		}
		needs.delete(manifest.name);
		nodes.push({
			name: manifest.name,
			dir: join(ROOT, rel.replace(/\/package\.json$/, '')),
			needs: [...needs],
		});
	}
	return nodes;
}

if (import.meta.main) {
	const script = process.argv[2];
	if (script === undefined) {
		console.error('Usage: bun run scripts/workspace.ts <script>');
		process.exit(1);
	}
	for (const wave of waves(await readNodes())) {
		const results = await Promise.all(
			wave.map(async (node) => {
				const run = await $`bun run ${script}`.cwd(node.dir).nothrow().quiet();
				const output = `${run.stdout}${run.stderr}`.trim();
				if (output) console.log(output.replace(/^/gm, `${node.name}: `));
				return run.exitCode === 0 ? undefined : node.name;
			}),
		);
		const failed = results.filter((name) => name !== undefined);
		if (failed.length > 0) {
			console.error(`${script} failed in ${failed.join(', ')}`);
			process.exit(1);
		}
	}
}

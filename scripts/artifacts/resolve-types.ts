import { packageOf } from './imports';

/** A JavaScript file and the declaration file tsc looks for beside it. */
const BESIDE: readonly (readonly [js: string, dts: string])[] = [
	['.js', '.d.ts'],
	['.mjs', '.d.mts'],
	['.cjs', '.d.cts'],
];

const DECLARATION = /\.d\.[mc]?ts$/;

/** An installed package: its manifest, and whether its folder holds a file. */
export type Installed = {
	manifest: Record<string, unknown>;
	has: (rel: string) => boolean;
};

/** The subpath `exports` keys a specifier under: `.`, or `./<rest>`. */
export function subpathOf(specifier: string): string {
	const rest = specifier.slice(packageOf(specifier).length);
	return rest === '' ? '.' : `.${rest}`;
}

/**
 * Whether a path leads tsc to a declaration file: the file itself, one
 * beside a `.js`, `.mjs` or `.cjs`, or, extensionless, `<path>.d.ts` or
 * `<path>/index.d.ts`.
 */
function declares(path: unknown, has: Installed['has']): boolean {
	if (typeof path !== 'string') return false;
	if (DECLARATION.test(path)) return has(path);
	const js = BESIDE.find(([ext]) => path.endsWith(ext));
	if (js) return has(path.slice(0, -js[0].length) + js[1]);
	return has(`${path}.d.ts`) || has(`${path.replace(/\/$/, '')}/index.d.ts`);
}

/**
 * Whether an `exports` entry, its `*` already replaced, names types: a
 * `types` condition whose file is there, or a target that `declares`.
 */
function entryTypes(value: unknown, has: Installed['has']): boolean {
	if (typeof value === 'string') return declares(value, has);
	if (Array.isArray(value)) return value.some((each) => entryTypes(each, has));
	if (value === null || typeof value !== 'object') return false;
	return Object.entries(value as Record<string, unknown>).some(([key, each]) =>
		key === 'types' || key.startsWith('types@')
			? typeof each === 'string' && (each.includes('*') || has(each))
			: entryTypes(each, has),
	);
}

/** Replaces every `*` in an entry's strings with what the pattern matched. */
function substitute(value: unknown, star: string): unknown {
	if (typeof value === 'string') return value.replaceAll('*', star);
	if (Array.isArray(value)) return value.map((each) => substitute(each, star));
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, each]) => [
			key,
			substitute(each, star),
		]),
	);
}

/** Whether `exports` is the entry of `.` itself: a string, an array, or conditions. */
function onlyDot(exports: unknown): boolean {
	return (
		typeof exports === 'string' ||
		Array.isArray(exports) ||
		(typeof exports === 'object' &&
			exports !== null &&
			!Object.keys(exports).some((key) => key.startsWith('.')))
	);
}

/**
 * The `exports` entry a subpath resolves to: the exact key first, then the
 * `*` pattern with the longest prefix. Conditions or a string at the top are
 * the entry of `.` alone. Undefined when `exports` does not export it.
 */
function exportsEntry(exports: unknown, subpath: string): unknown {
	if (onlyDot(exports)) return subpath === '.' ? exports : undefined;
	const map = exports as Record<string, unknown>;
	if (Object.hasOwn(map, subpath)) return map[subpath];
	let best: [prefix: string, suffix: string, key: string] | undefined;
	for (const key of Object.keys(map)) {
		const [prefix = '', suffix = '', ...more] = key.split('*');
		if (!key.includes('*') || more.length > 0) continue;
		if (
			subpath.startsWith(prefix) &&
			subpath.endsWith(suffix) &&
			subpath.length >= prefix.length + suffix.length &&
			(!best || prefix.length > best[0].length)
		) {
			best = [prefix, suffix, key];
		}
	}
	if (!best) return undefined;
	const [prefix, suffix, key] = best;
	return substitute(
		map[key],
		subpath.slice(prefix.length, subpath.length - suffix.length),
	);
}

/**
 * Whether a package ships declarations for one subpath of it, as tsc under
 * `bundler` or `node16` resolution finds them. With `exports`, only the
 * subpath's entry counts: a `types` condition whose file is there, or a
 * target with a declaration file beside it (yargs 18 types `./browser`
 * alone, so `yargs` itself is untyped). Without, `typesVersions`, then for
 * `.` a `types` or `typings` field, `main` or an `index.d.ts`, and for any
 * other subpath the file it names, extensionless paths read as tsc does.
 */
export function shipsTypes(
	{ manifest, has }: Installed,
	subpath = '.',
): boolean {
	const exports = manifest['exports'];
	if (exports !== undefined && exports !== null) {
		return entryTypes(exportsEntry(exports, subpath), has);
	}
	if (manifest['typesVersions'] !== undefined) return true;
	if (subpath !== '.') return declares(subpath, has);
	return (
		declares(manifest['types'], has) ||
		declares(manifest['typings'], has) ||
		declares(manifest['main'], has) ||
		has('index.d.ts')
	);
}

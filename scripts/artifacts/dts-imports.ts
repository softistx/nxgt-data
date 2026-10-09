import { dirname, join, resolve } from 'node:path';

/**
 * A relative specifier in a declaration, quoted, after what introduces it:
 * `from './x'`, `import './x'`, `import('./x')`, `declare module './x'`,
 * `'.'` and `'..'` included.
 */
const RELATIVE =
	/(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\bdeclare\s+module\s+)(['"])(\.\.?(?:\/[^'"]*)?)\2/g;

/** A string literal, kept whole, or a comment, blanked. */
const TOKEN =
	/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * `text` with every comment replaced by as many spaces, newlines kept, so
 * an offset in it is an offset in `text`. A JSDoc example such as
 * `import * as caches from './caches'` is then not read as an import.
 */
function withoutComments(text: string): string {
	return text.replace(TOKEN, (token) =>
		token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token,
	);
}

/**
 * `text`, a declaration `file` tsc emitted, with each relative import given
 * the extension Node needs: `./x.js` when `./x.d.ts` was emitted, else
 * `./x/index.js` when `./x/index.d.ts` was. tsc keeps the sources'
 * extensionless `./x`, which `bundler` resolves and `nodenext` does not. A
 * specifier already ending in `.js`, `.mjs` or `.cjs` is left, and so is
 * one in a comment; one no emitted declaration matches is returned in
 * `unmatched`. Pure, so it has specs. A string literal type that spells an
 * import (`"from './a'"`) would be rewritten too, and a `//` inside a nested
 * template type taken for a comment; tsc emits neither here, and `build.ts`
 * checks the result with `declarationSpecifiers`, which reads both right.
 */
export function withExtensions(
	text: string,
	file: string,
	emitted: ReadonlySet<string>,
): { readonly text: string; readonly unmatched: string[] } {
	const unmatched: string[] = [];
	const edits: [at: number, length: number, replacement: string][] = [];
	for (const match of withoutComments(text).matchAll(RELATIVE)) {
		const [all, lead = '', quote = '', path = ''] = match;
		if (/\.[cm]?js$/.test(path)) continue;
		const base = resolve(dirname(file), path);
		const folder = path.replace(/\/$/, '');
		const js = emitted.has(`${base}.d.ts`)
			? `${path}.js`
			: emitted.has(join(base, 'index.d.ts'))
				? `${folder}/index.js`
				: undefined;
		if (!js) {
			unmatched.push(path);
			continue;
		}
		edits.push([match.index, all.length, `${lead}${quote}${js}${quote}`]);
	}
	let fixed = text;
	for (const [at, length, replacement] of edits.reverse()) {
		fixed = fixed.slice(0, at) + replacement + fixed.slice(at + length);
	}
	return { text: fixed, unmatched };
}

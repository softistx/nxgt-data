import { describe, expect, test } from 'bun:test';
import { withExtensions } from './dts-imports';

const emitted = new Set([
	'/p/dist/index.d.ts',
	'/p/dist/zod-scalar.d.ts',
	'/p/dist/scalars/index.d.ts',
	'/p/dist/scalars/date.d.ts',
]);
const fix = (text: string, file = '/p/dist/index.d.ts') =>
	withExtensions(text, file, emitted);

describe('withExtensions', () => {
	test('gives a file its .js and a folder its /index.js', () => {
		expect(
			fix(
				'export { zodScalar } from \'./zod-scalar\';\nexport * from "./scalars";',
			).text,
		).toBe(
			'export { zodScalar } from \'./zod-scalar.js\';\nexport * from "./scalars/index.js";',
		);
	});

	test('reads import(), a side-effect import, declare module, and . or ..', () => {
		const inner = '/p/dist/scalars/date.d.ts';
		expect(fix("type T = import('../zod-scalar').ZodScalar;", inner).text).toBe(
			"type T = import('../zod-scalar.js').ZodScalar;",
		);
		expect(fix("import './zod-scalar';").text).toBe(
			"import './zod-scalar.js';",
		);
		expect(fix("declare module './zod-scalar' {}").text).toBe(
			"declare module './zod-scalar.js' {}",
		);
		expect(fix("export * from '.';", inner).text).toBe(
			"export * from './index.js';",
		);
		expect(fix("export * from '..';", inner).text).toBe(
			"export * from '../index.js';",
		);
	});

	test('leaves an import in a comment, and reads one after it', () => {
		const text = [
			'/**',
			" * `import * as caches from './caches'` brings what that file exports.",
			' */',
			"// export * from './gone';",
			"export * from './zod-scalar'; // from './gone'",
		].join('\n');
		const fixed = fix(text);
		expect(fixed.unmatched).toEqual([]);
		expect(fixed.text).toBe(
			text.replace("from './zod-scalar';", "from './zod-scalar.js';"),
		);
	});

	test('reads a string holding // or /* as a string, not a comment', () => {
		expect(
			fix("type U = 'http://x' | '/*';\nexport * from './zod-scalar';").text,
		).toBe("type U = 'http://x' | '/*';\nexport * from './zod-scalar.js';");
	});

	test('leaves an extension, a package and a name it cannot match', () => {
		expect(fix("export * from './zod-scalar.js';").text).toBe(
			"export * from './zod-scalar.js';",
		);
		expect(fix("import { z } from 'zod';").text).toBe(
			"import { z } from 'zod';",
		);
		const missing = fix("export * from './gone';");
		expect(missing.text).toBe("export * from './gone';");
		expect(missing.unmatched).toEqual(['./gone']);
	});
});

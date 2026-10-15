import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as root from '../index';

// `@nxgt/s3/testing` is a subpath: a consumer that never imports it must not
// load a line of it. The root entry is the only thing `dist/index.js` bundles.

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
	});
}

test('nothing in src/ outside testing/ imports it', () => {
	const src = join(import.meta.dir, '..');
	const offenders = sources(src)
		.filter((path) => !relative(src, path).startsWith(`testing${sep}`))
		.filter((path) =>
			/from\s+['"][^'"]*testing[^'"]*['"]/.test(readFileSync(path, 'utf8')),
		);
	expect(offenders).toEqual([]);
});

test('the root entry exports no test server', () => {
	expect(Object.keys(root)).not.toContain('startTestS3');
	expect(Object.keys(root)).not.toContain('seaweedfsBinary');
});

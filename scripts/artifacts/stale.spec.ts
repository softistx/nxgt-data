import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_A_BUILD_INPUT, staleBuilds } from './stale';

describe('staleBuilds', () => {
	const dirs: string[] = [];
	afterAll(() =>
		Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
	);

	test('reports a src/ newer than dist/', async () => {
		const root = await mkdtemp(join(tmpdir(), 'nxgt-data-stale-'));
		dirs.push(root);
		const pkg = (name: string) => ({ name, dir: join(root, name) });

		for (const name of ['fresh', 'stale']) {
			await mkdir(join(root, name, 'src'), { recursive: true });
			await writeFile(join(root, name, 'src', 'index.ts'), '');
			await mkdir(join(root, name, 'dist'), { recursive: true });
			await writeFile(join(root, name, 'dist', 'index.js'), '');
		}
		const old = new Date('2026-01-01T00:00:00Z');
		const later = new Date('2026-01-01T00:01:00Z');
		await utimes(join(root, 'fresh', 'src', 'index.ts'), old, old);
		await utimes(join(root, 'fresh', 'dist', 'index.js'), later, later);
		await utimes(join(root, 'stale', 'dist', 'index.js'), old, old);
		await utimes(join(root, 'stale', 'src', 'index.ts'), later, later);

		expect(await staleBuilds([pkg('fresh'), pkg('stale')])).toEqual([
			'stale: src/ is 60s newer than dist/',
		]);
	});

	test('does not count a spec or a snapshot as a build input', () => {
		// CI runs the tests between the build and this script, and `bun test`
		// rewrites a snapshot's mtime: counting them failed a green pipeline.
		expect(NOT_A_BUILD_INPUT.test('collection/upsert.spec.ts')).toBe(true);
		expect(NOT_A_BUILD_INPUT.test('__snapshots__/a.snap')).toBe(true);
		expect(NOT_A_BUILD_INPUT.test('collection/upsert.ts')).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { folder, streamOf } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { directorySource, directoryTarget } from './directory';

let tmp: Awaited<ReturnType<typeof folder>>;
beforeEach(async () => {
	tmp = await folder();
});
afterEach(() => tmp.remove());

describe('directorySource', () => {
	test('every regular file, by its relative path, sorted; links skipped', async () => {
		const root = join(tmp.path, 'src');
		await mkdir(join(root, 'b', 'c'), { recursive: true });
		await mkdir(join(root, 'empty'));
		await writeFile(join(root, 'z.txt'), 'z');
		await writeFile(join(root, 'b', 'c', 'd.txt'), 'd');
		await symlink('/etc/hosts', join(root, 'link'));
		const names: string[] = [];
		const texts: string[] = [];
		for await (const entry of directorySource({ path: root }).entries()) {
			names.push(entry.name);
			texts.push(await new Response(await entry.open()).text());
		}
		expect(names).toEqual(['b/c/d.txt', 'z.txt']);
		expect(texts).toEqual(['d', 'z']);
	});

	test('a link to a folder is not followed, nor one back up the tree', async () => {
		const root = join(tmp.path, 'src');
		const elsewhere = join(tmp.path, 'elsewhere');
		await mkdir(root);
		await mkdir(elsewhere);
		await writeFile(join(elsewhere, 'secret.txt'), 's');
		await writeFile(join(root, 'a.txt'), 'a');
		await symlink(elsewhere, join(root, 'dirlink'));
		await symlink(root, join(root, 'loop'));
		const names: string[] = [];
		for await (const entry of directorySource({ path: root }).entries()) {
			names.push(entry.name);
		}
		expect(names).toEqual(['a.txt']);
	});

	test('a folder that is not there rejects, rather than giving nothing', async () => {
		const source = directorySource({ path: join(tmp.path, 'missing') });
		const error = await rejection(
			(async () => {
				for await (const _ of source.entries());
			})(),
		);
		expect(error).toHaveProperty('code', 'ENOENT');
	});
});

describe('directoryTarget', () => {
	test('writes nested files', async () => {
		const target = directoryTarget({ path: join(tmp.path, 'out') });
		await target.write('a/b.txt', streamOf('hello'));
		expect(await readFile(join(tmp.path, 'out', 'a', 'b.txt'), 'utf8')).toBe(
			'hello',
		);
	});

	test.each(['../x', 'a/../../x', '/etc/x', 'a//b', './x', 'a\\b'])(
		'refuses %s before writing anything',
		async (name) => {
			const target = directoryTarget({ path: join(tmp.path, 'out') });
			const error = await rejection(target.write(name, streamOf('x')));
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).not.toContain(name);
		},
	);

	test('refuses a folder that is a link, which would write outside', async () => {
		const out = join(tmp.path, 'out');
		const outside = join(tmp.path, 'outside');
		await mkdir(out);
		await mkdir(outside);
		await symlink(outside, join(out, 'a'));
		const error = await rejection(
			directoryTarget({ path: out, overwrite: true }).write(
				'a/evil.txt',
				streamOf('x'),
			),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(await readdir(outside)).toEqual([]);
	});

	test('refuses to replace a file unless told to', async () => {
		const out = join(tmp.path, 'out');
		const target = directoryTarget({ path: out });
		await target.write('a', streamOf('one'));
		expect(await rejection(target.write('a', streamOf('two')))).toBeInstanceOf(
			TypeError,
		);
		await directoryTarget({ path: out, overwrite: true }).write(
			'a',
			streamOf('two'),
		);
		expect(await readFile(join(out, 'a'), 'utf8')).toBe('two');
	});

	test('a file that appears while the entry streams is not replaced', async () => {
		const out = join(tmp.path, 'out');
		// The first pull runs as the stream is made, before write checks the
		// folder; the second runs while the entry is being written.
		let pulls = 0;
		const racing = new ReadableStream<Uint8Array>({
			async pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					return controller.enqueue(new TextEncoder().encode('ours'));
				}
				await writeFile(join(out, 'a'), 'theirs');
				controller.close();
			},
		});
		const error = await rejection(
			directoryTarget({ path: out }).write('a', racing),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(await readFile(join(out, 'a'), 'utf8')).toBe('theirs');
		expect(await readdir(out)).toEqual(['a']);
	});

	test('a stream that fails at its end lands nothing', async () => {
		const out = join(tmp.path, 'out');
		const failing = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('half'));
				controller.error(new Error('damaged'));
			},
		});
		const error = await rejection(
			directoryTarget({ path: out }).write('a', failing),
		);
		expect(error).toHaveProperty('message', 'damaged');
		expect(await readdir(out)).toEqual([]);
	});
});

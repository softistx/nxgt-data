import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { folder } from '../../test/fixtures';
import { localRepository } from './local';

let tmp: Awaited<ReturnType<typeof folder>>;
beforeEach(async () => {
	tmp = await folder();
});
afterEach(() => tmp.remove());

async function keys(
	repository: ReturnType<typeof localRepository>,
	prefix: string,
) {
	const found: string[] = [];
	for await (const key of repository.list(prefix)) found.push(key);
	return found.sort();
}

describe('localRepository', () => {
	test('put, get, list and delete', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		expect(repository.name).toBe('local');
		const source = join(tmp.path, 'source');
		await writeFile(source, 'hello');
		await repository.put('app/one/0.age', source);
		await repository.put('app/two/0.age', source);
		await repository.put('other/x', source);

		expect(
			await new Response(await repository.get('app/one/0.age')).text(),
		).toBe('hello');
		expect(await repository.get('app/none')).toBeUndefined();
		expect(await keys(repository, 'app/')).toEqual([
			'app/one/0.age',
			'app/two/0.age',
		]);
		expect(await keys(repository, '')).toHaveLength(3);
		expect(
			await keys(localRepository({ path: join(tmp.path, 'none') }), 'app/'),
		).toEqual([]);

		await repository.delete('app/one/0.age');
		await repository.delete('app/one/0.age');
		expect(await keys(repository, 'app/')).toEqual(['app/two/0.age']);
	});

	test('a file being written is never listed, and a put leaves only its key', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		const source = join(tmp.path, 'source');
		await writeFile(source, 'x');
		await repository.put('app/a', source);
		await writeFile(join(tmp.path, 'repo', 'app', 'b.partial-123'), 'half');
		expect(await keys(repository, 'app/')).toEqual(['app/a']);
		expect((await readdir(join(tmp.path, 'repo', 'app'))).sort()).toEqual([
			'a',
			'b.partial-123',
		]);
	});

	test('a failed put leaves no partial file', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		let failed = false;
		try {
			await repository.put('app/a', join(tmp.path, 'missing'));
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		expect(await readdir(join(tmp.path, 'repo', 'app'))).toEqual([]);
	});

	test('list follows no link out of the folder', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		const source = join(tmp.path, 'source');
		await writeFile(source, 'x');
		await repository.put('app/a', source);
		await mkdir(join(tmp.path, 'elsewhere'));
		await writeFile(join(tmp.path, 'elsewhere', 'b'), 'b');
		await symlink(
			join(tmp.path, 'elsewhere'),
			join(tmp.path, 'repo', 'app', 'l'),
		);
		expect(await keys(repository, 'app/')).toEqual(['app/a']);
	});

	test('a key that would leave the folder is refused', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		for (const key of ['../x', 'a/../../x', '/etc/x', 'a//b', 'a/./b']) {
			expect(() => repository.get(key)).toThrow('a key is not a relative path');
		}
	});

	test('a delete removes the folders it leaves empty, never the root', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		const source = join(tmp.path, 'source');
		await writeFile(source, 'x');
		await repository.put('app/id/0.age', source);
		await repository.put('app/other/0.age', source);
		await repository.delete('app/id/0.age');
		expect(await readdir(join(tmp.path, 'repo', 'app'))).toEqual(['other']);
		await repository.delete('app/other/0.age');
		expect(await readdir(join(tmp.path, 'repo'))).toEqual([]);
	});

	test('a put racing a delete of its folder still lands', async () => {
		const repository = localRepository({ path: join(tmp.path, 'repo') });
		const source = join(tmp.path, 'source');
		await writeFile(source, 'x');
		for (let round = 0; round < 50; round++) {
			await Promise.all([
				repository.put(`app/locks/${round}-a.json`, source),
				repository.put(`app/locks/${round}-b.json`, source),
				repository.delete(`app/locks/${round - 1}-a.json`),
				repository.delete(`app/locks/${round - 1}-b.json`),
			]);
		}
		expect(await keys(repository, 'app/locks/')).toEqual([
			'app/locks/49-a.json',
			'app/locks/49-b.json',
		]);
	});

	test('a relative path is refused', () => {
		expect(() => localRepository({ path: 'backups' })).toThrow(
			'localRepository: path must be an absolute path',
		);
	});
});

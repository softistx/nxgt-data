import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
	memoryTarget,
	streamOf,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindBackup } from '../backups/bind-backup';
import { defineBackup } from '../definition/define-backup';
import type { RepositoryOutcome } from '../errors/backup-error';
import { localRepository } from '../repository/local';
import { directorySource, directoryTarget } from '../source/directory';
import type { BackupSource, Since } from '../source/types';

const app = defineBackup({ name: 'app' });

let root: Awaited<ReturnType<typeof folder>>;
let keys: KeyPair;

beforeEach(async () => {
	root = await folder();
	keys = await keyPair();
});
afterEach(() => root.remove());

function local(name = 'local') {
	return localRepository({ path: join(root.path, name), name });
}

function bound(repositories = [local()] as const) {
	return bindBackup(app, {
		repositories: repositories as unknown as [ReturnType<typeof local>],
		recipients: [keys.recipient],
		tmpDir: root.path,
	});
}

/** A source whose entries carry a fingerprint, recording what it opened and was given. */
function fingerprinted(
	entries: Record<string, [content: string, fingerprint?: string]>,
	position?: string,
): BackupSource & { opened: string[]; given: (Since | undefined)[] } {
	const opened: string[] = [];
	const given: (Since | undefined)[] = [];
	return {
		kind: 'memory',
		opened,
		given,
		async *entries(since) {
			given.push(since);
			for (const [name, [content, fingerprint]] of Object.entries(entries)) {
				yield {
					name,
					fingerprint,
					open: () => {
						opened.push(name);
						return streamOf(content);
					},
				};
			}
		},
		position: () => position,
	};
}

async function restored(
	backups: ReturnType<typeof bound>,
	id: string,
): Promise<Record<string, string>> {
	const target = memoryTarget();
	await backups.restore(id, target, { identities: [keys.identity] });
	return Object.fromEntries(
		[...target.written].map(([name, bytes]) => [
			name,
			new TextDecoder().decode(bytes),
		]),
	);
}

const incremental = () =>
	({ kind: 'incremental', identities: [keys.identity] }) as const;

describe('incremental', () => {
	test('stores what changed, and restores the whole view', async () => {
		const backups = bound();
		const full = await backups.create(
			memorySource({ same: 'same', changed: 'v1', removed: 'gone' }),
		);
		const next = await backups.create(
			memorySource({ same: 'same', changed: 'v2', added: 'new' }),
			incremental(),
		);
		expect(next).toMatchObject({
			kind: 'incremental',
			parent: full.id,
			entries: 3,
			reused: 1,
		});
		expect(await restored(backups, next.id)).toEqual({
			same: 'same',
			changed: 'v2',
			added: 'new',
		});
		expect(await restored(backups, full.id)).toEqual({
			same: 'same',
			changed: 'v1',
			removed: 'gone',
		});
		const listed = (await backups.list()).backups;
		expect(listed.map((b) => [b.kind, b.parent, b.entries])).toEqual([
			['full', null, 3],
			['incremental', full.id, 2],
		]);
	});

	test('does not open an entry whose fingerprint is the recorded one', async () => {
		const backups = bound();
		await backups.create(
			fingerprinted({ a: ['a', 'fa'], b: ['b', 'fb'], c: ['c'] }),
		);
		const source = fingerprinted({
			a: ['a', 'fa'],
			b: ['B', 'fb2'],
			c: ['c'],
		});
		const next = await backups.create(source, incremental());
		expect(source.opened).toEqual(['b', 'c']);
		expect(next.reused).toBe(2);
		expect(await restored(backups, next.id)).toEqual({
			a: 'a',
			b: 'B',
			c: 'c',
		});
	});

	test('a chain points each entry to the backup that stored it', async () => {
		const backups = bound();
		const one = await backups.create(memorySource({ a: '1', b: '1', c: '1' }));
		const two = await backups.create(
			memorySource({ a: '1', b: '2', c: '1' }),
			incremental(),
		);
		const three = await backups.create(
			memorySource({ a: '1', b: '2', c: '3' }),
			incremental(),
		);
		expect(three.parent).toBe(two.id);
		expect(await restored(backups, three.id)).toEqual({
			a: '1',
			b: '2',
			c: '3',
		});
		const verified = await backups.verify(three.id, {
			identities: [keys.identity],
		});
		expect(verified.chain).toEqual([three.id, two.id, one.id]);
		expect(verified.objects).toBe(4);
		const keyless = await backups.verify(three.id);
		expect(keyless.objects).toBe(3 + 1 + 1 + 1 + 1 + 1);
	});

	test('gives the source what the base recorded, and keeps its position', async () => {
		const backups = bound();
		const first = fingerprinted({ a: ['a', 'fa'] }, 'token-1');
		const full = await backups.create(first);
		expect(first.given).toEqual([undefined]);
		const second = fingerprinted({ a: ['a', 'fa'] }, 'token-2');
		await backups.create(second, incremental());
		const since = second.given[0] as Since;
		expect(since.id).toBe(full.id);
		expect(since.position).toBe('token-1');
		expect([...since.entries]).toEqual([
			[
				'a',
				{
					size: 1,
					sha256: new Bun.CryptoHasher('sha256').update('a').digest('hex'),
					fingerprint: 'fa',
				},
			],
		]);
		const third = fingerprinted({ a: ['a', 'fa'] });
		await backups.create(third, incremental());
		expect((third.given[0] as Since).position).toBe('token-2');
	});
});

describe('incremental of a folder', () => {
	test('reads only the files that moved', async () => {
		const tree = join(root.path, 'tree');
		await mkdir(join(tree, 'sub'), { recursive: true });
		await writeFile(join(tree, 'a'), 'a');
		await writeFile(join(tree, 'sub', 'b'), 'b');
		await writeFile(join(tree, 'gone'), 'x');
		const backups = bound();
		await backups.create(directorySource({ path: tree }));
		const quiet = await backups.create(
			directorySource({ path: tree }),
			incremental(),
		);
		expect(quiet).toMatchObject({ entries: 3, reused: 3 });
		await Bun.sleep(5);
		await writeFile(join(tree, 'sub', 'b'), 'B');
		await rm(join(tree, 'gone'));
		const moved = await backups.create(
			directorySource({ path: tree }),
			incremental(),
		);
		expect(moved).toMatchObject({ entries: 2, reused: 1 });
		const out = join(root.path, 'out');
		await backups.restore(moved.id, directoryTarget({ path: out }), {
			identities: [keys.identity],
		});
		expect(await readFile(join(out, 'sub', 'b'), 'utf8')).toBe('B');
		expect(await readFile(join(out, 'a'), 'utf8')).toBe('a');
	});
});

describe('differential', () => {
	test('builds on the newest full backup, past any incremental', async () => {
		const backups = bound();
		const full = await backups.create(memorySource({ a: '1', b: '1' }));
		await backups.create(memorySource({ a: '2', b: '1' }), incremental());
		const diff = await backups.create(memorySource({ a: '2', b: '1' }), {
			kind: 'differential',
			identities: [keys.identity],
		});
		expect(diff).toMatchObject({
			kind: 'differential',
			parent: full.id,
			reused: 1,
		});
		expect(await restored(backups, diff.id)).toEqual({ a: '2', b: '1' });
	});
});

describe('building on', () => {
	test('nothing to build on is NOT_FOUND', async () => {
		const error = await rejection(
			bound().create(memorySource({ a: 'a' }), incremental()),
		);
		expect(error).toHaveProperty('code', 'NOT_FOUND');
		expect(error).toHaveProperty(
			'message',
			'create on "app": no backup to build on (repository "local")',
		);
		const backups = bound();
		await backups.create(memorySource({ a: 'a' }));
		await rm(join(root.path, 'local', 'app'), { recursive: true });
		const differential = await rejection(
			backups.create(memorySource({ a: 'a' }), {
				kind: 'differential',
				identities: [keys.identity],
			}),
		);
		expect(differential).toHaveProperty(
			'message',
			'create on "app": no full backup to build on (repository "local")',
		);
	});

	test('a backup dated after this one is never built on', async () => {
		const backups = bound();
		const now = await backups.create(memorySource({ a: 'a' }));
		setSystemTime(new Date(Date.now() + 365 * 86_400_000));
		try {
			await backups.create(memorySource({ a: 'future' }));
		} finally {
			setSystemTime();
		}
		const next = await backups.create(memorySource({ a: 'a' }), incremental());
		expect(next.parent).toBe(now.id);
	});

	test('a source of another kind is refused', async () => {
		const backups = bound();
		await backups.create(memorySource({ a: 'a' }));
		const other: BackupSource = {
			kind: 'directory',
			async *entries() {},
		};
		const error = await rejection(backups.create(other, incremental()));
		expect(error).toBeInstanceOf(TypeError);
		expect(error).toHaveProperty(
			'message',
			'create on "app": the source is not of the kind the backup it builds on was made from',
		);
	});

	test('a repository without the base is left out, the others store it', async () => {
		const first = local('first');
		const second = local('second');
		const both = bound([first, second] as never);
		await bound([first] as never).create(memorySource({ a: 'a' }));
		const error = await rejection(
			both.create(memorySource({ a: 'b' }), incremental()),
		);
		expect(error).toHaveProperty('code', 'PARTIAL');
		const outcomes = (error as { outcomes: RepositoryOutcome[] }).outcomes;
		expect(outcomes[0]).toEqual({ repository: 'first', stored: true });
		const outcome = outcomes[1];
		expect(outcome?.stored).toBe(false);
		const left = outcome?.stored === false ? outcome.error : undefined;
		expect(left).toHaveProperty('code', 'NOT_FOUND');
		expect(left).toHaveProperty(
			'message',
			'create on "app": the backup it builds on is not in this repository (repository "second")',
		);
	});

	test('a base that is gone makes its chain unreadable, not silently short', async () => {
		const backups = bound();
		const full = await backups.create(memorySource({ a: 'a', b: 'b' }));
		const next = await backups.create(
			memorySource({ a: 'a', b: 'c' }),
			incremental(),
		);
		await rm(join(root.path, 'local', 'app', full.id), { recursive: true });
		for (const attempt of [
			() => restored(backups, next.id),
			() => backups.verify(next.id),
		]) {
			const error = await rejection(attempt());
			expect(error).toHaveProperty('code', 'INTEGRITY');
			expect(error).toHaveProperty(
				'message',
				expect.stringContaining('a backup it builds on is missing'),
			);
		}
	});

	test('prune keeps the base of a kept incremental', async () => {
		const backups = bound();
		const full = await backups.create(memorySource({ a: 'a' }));
		const next = await backups.create(memorySource({ a: 'b' }), incremental());
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.kept.map((d) => [d.id, d.reasons])).toEqual([
			[next.id, ['last 1 of 1']],
			[full.id, [`parent of ${next.id}`]],
		]);
		expect(await restored(backups, next.id)).toEqual({ a: 'b' });
	});

	test('options that could never work are refused before anything is read', async () => {
		const backups = bound();
		expect(() =>
			backups.create(memorySource({}), { kind: 'snapshot' } as never),
		).toThrow(
			'create on "app": kind must be full, incremental or differential',
		);
		expect(() =>
			backups.create(memorySource({}), {
				kind: 'incremental',
				identities: [],
			}),
		).toThrow(
			'create on "app": identities must list at least one age secret key',
		);
		await backups.create(memorySource({ a: 'a' }));
		const long = await rejection(
			backups.create(fingerprinted({ a: ['a', 'f'.repeat(1025)] })),
		);
		expect(long).toHaveProperty(
			'message',
			'create on "app": the source gave a fingerprint that is not a string of at most 1024 bytes',
		);
		const position = await rejection(
			backups.create(fingerprinted({ a: ['a'] }, 'p'.repeat(65_537))),
		);
		expect(position).toHaveProperty(
			'message',
			'create on "app": the source gave a position that is not a string of at most 64 KiB',
		);
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindBackup } from '../backups/bind-backup';
import { defineBackup } from '../definition/define-backup';
import { BackupError } from '../errors/backup-error';
import { newBackupId } from '../format/ids';
import { LOCK_FORMAT } from '../lock/lock';
import { localRepository } from '../repository/local';
import type { Repository } from '../repository/types';

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

function bound(repository: Repository = local(), lease?: number) {
	return bindBackup(app, {
		repositories: [repository],
		recipients: [keys.recipient],
		tmpDir: root.path,
		...(lease === undefined ? {} : { lock: { lease } }),
	});
}

async function three(
	backups: ReturnType<typeof bound>,
): Promise<[string, string, string]> {
	const one = async (name: string) =>
		(await backups.create(memorySource({ [name]: name }))).id;
	const a = await one('a');
	const b = await one('b');
	return [a, b, await one('c')];
}

async function folders(): Promise<string[]> {
	return (
		await readdir(join(root.path, 'local', 'app')).catch(() => [])
	).sort();
}

/** Leaves a live lock of another create in the repository. */
async function lockedByCreate(): Promise<void> {
	const id = newBackupId(new Date());
	const locks = join(root.path, 'local', 'app', 'locks');
	await mkdir(locks, { recursive: true });
	await writeFile(
		join(locks, `${id}.json`),
		JSON.stringify({
			format: LOCK_FORMAT,
			id,
			operation: 'create',
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		}),
	);
}

describe('prune', () => {
	test('removes what no rule keeps, and lists it gone', async () => {
		const backups = bound();
		const [a, b, c] = await three(backups);
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.dryRun).toBe(false);
		expect(pruned.kept.map((d) => [d.id, d.reasons])).toEqual([
			[c, ['last 1 of 1']],
		]);
		expect(pruned.removed.map((d) => d.id)).toEqual([b, a]);
		expect((await backups.list()).backups.map((x) => x.id)).toEqual([c]);
		expect(await folders()).toEqual([c]);
	});

	test('dryRun says the same and removes nothing', async () => {
		const backups = bound();
		const made = await three(backups);
		const planned = await backups.prune({ keep: { last: 1 }, dryRun: true });
		expect(planned.dryRun).toBe(true);
		expect(planned.removed).toHaveLength(2);
		expect(await folders()).toEqual(made.sort());
		const done = await backups.prune({ keep: { last: 1 } });
		expect(done.removed).toEqual(planned.removed);
	});

	test('a held backup stays until it is lifted', async () => {
		const backups = bound();
		const [a, , c] = await three(backups);
		await backups.hold(a);
		expect((await backups.list()).backups.map((x) => [x.id, x.held])).toEqual([
			[a, true],
			[expect.any(String), false],
			[c, false],
		]);
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.kept.map((d) => d.id)).toEqual([c, a]);
		expect(pruned.kept[1]?.reasons).toEqual(['held']);
		await backups.unhold(a);
		await backups.unhold(a);
		const after = await backups.prune({ keep: { last: 1 } });
		expect(after.removed.map((d) => d.id)).toEqual([a]);
	});

	test('a hold needs the backup to be there', async () => {
		const error = await rejection(bound().hold(newBackupId(new Date())));
		expect(error).toHaveProperty('code', 'NOT_FOUND');
		expect(() => bound().hold('nope')).toThrow(
			'hold on "app": the id is not a backup id',
		);
	});

	test('a backup that never got a manifest goes once it is old enough', async () => {
		const backups = bound();
		await backups.create(memorySource({ a: 'a' }));
		const old = newBackupId(new Date(Date.now() - 2 * 86_400_000));
		const young = newBackupId(new Date(Date.now() - 60_000));
		for (const id of [old, young]) {
			await mkdir(join(root.path, 'local', 'app', id), { recursive: true });
			await writeFile(join(root.path, 'local', 'app', id, '0.age'), 'x');
		}
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.incomplete).toEqual([old]);
		const left = await folders();
		expect(left).not.toContain(old);
		expect(left).toContain(young);
	});

	test('a backup whose manifest does not read is never removed', async () => {
		const backups = bound();
		const [a] = await three(backups);
		await writeFile(join(root.path, 'local', 'app', a, 'manifest.json'), '{}');
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.unreadable).toEqual([a]);
		expect(await folders()).toContain(a);
	});

	test('the manifest goes first, so a cut prune leaves no backup half there', async () => {
		const inner = local();
		const deleted: string[] = [];
		const recording: Repository = {
			...inner,
			delete: async (key) => {
				if (!key.includes('/locks/'))
					deleted.push(key.split('/').slice(2).join('/'));
				return inner.delete(key);
			},
		};
		const backups = bound(recording);
		await three(backups);
		await backups.prune({ keep: { last: 2 } });
		expect(deleted[0]).toBe('manifest.json');
		expect(deleted).toContain('catalog.age');
		expect(deleted).toContain('0.age');
	});

	test('takes the lock: another writer holding it refuses the prune', async () => {
		const backups = bound();
		await three(backups);
		await lockedByCreate();
		const error = await rejection(backups.prune({ keep: { last: 1 } }));
		expect(error).toBeInstanceOf(BackupError);
		expect(error).toHaveProperty('code', 'LOCKED');
		expect(error).toHaveProperty(
			'message',
			'prune on "app": another create, prune or hold has the lock (repository "local")',
		);
		expect(
			await backups.prune({ keep: { last: 1 }, dryRun: true }),
		).toHaveProperty('dryRun', true);
		expect((await backups.list()).backups).toHaveLength(3);
	});

	test('a lease that runs out stops the prune before its next delete', async () => {
		const inner = local();
		let armed = false;
		let lockPuts = 0;
		const slow: Repository = {
			...inner,
			put: async (key, file) => {
				if (armed && key.includes('/locks/') && ++lockPuts > 1) {
					throw new Error('unreachable');
				}
				return inner.put(key, file);
			},
			delete: async (key) => {
				if (!key.includes('/locks/')) await Bun.sleep(300);
				return inner.delete(key);
			},
		};
		const backups = bound(slow, 1000);
		await three(backups);
		armed = true;
		const error = await rejection(backups.prune({ keep: { last: 1 } }));
		expect(error).toHaveProperty('code', 'LEASE_LOST');
		expect(error).toHaveProperty(
			'message',
			`prune on "app": the lock's lease ran out before it was done (repository "local")`,
		);
	});

	test('options that could never work are refused before anything is read', () => {
		expect(() => bound().prune({ keep: {} })).toThrow(
			'prune on "app": keep must name at least one rule',
		);
		for (const now of [
			new Date('garbage'),
			'2026-10-04' as unknown as Date,
			Date.now() as unknown as Date,
		]) {
			expect(() => bound().prune({ keep: { within: 1 }, now })).toThrow(
				'prune on "app": now must be a valid Date',
			);
		}
		expect(() =>
			bound().prune({ keep: { last: 1 }, incompleteAfter: 1000 }),
		).toThrow(
			'prune on "app": incompleteAfter must be a whole number of milliseconds, two lock leases at least',
		);
	});
});

describe('hold', () => {
	test('holds in every repository that has the backup, and prune there keeps it', async () => {
		const first = local('first');
		const second = local('second');
		const both = bindBackup(app, {
			repositories: [first, second],
			recipients: [keys.recipient],
			tmpDir: root.path,
		});
		const [a] = await three(both);
		const onlyFirst = (await bound(first).create(memorySource({ x: 'x' }))).id;
		expect(await both.hold(a)).toEqual({
			id: a,
			repositories: ['first', 'second'],
		});
		expect(await both.hold(onlyFirst)).toEqual({
			id: onlyFirst,
			repositories: ['first'],
		});
		const pruned = await both.prune({ from: 'second', keep: { last: 1 } });
		expect(pruned.kept.map((d) => [d.id, d.reasons])).toContainEqual([
			a,
			['held'],
		]);
		expect(await both.unhold(a, { from: 'second' })).toEqual({
			id: a,
			repositories: ['second'],
		});
		const after = await both.prune({ from: 'second', keep: { last: 1 } });
		expect(after.removed.map((d) => d.id)).toContain(a);
		expect(
			(await bound(first).list()).backups.find((x) => x.id === a)?.held,
		).toBe(true);
	});

	test('a hold waits for no one: a create holding the lock refuses it', async () => {
		const backups = bound();
		const [a] = await three(backups);
		await lockedByCreate();
		const error = await rejection(backups.hold(a));
		expect(error).toHaveProperty('code', 'LOCKED');
		expect(error).toHaveProperty(
			'message',
			'hold on "app": another create, prune or hold has the lock (repository "local")',
		);
		const lifted = await rejection(backups.unhold(a));
		expect(lifted).toHaveProperty(
			'message',
			expect.stringMatching(/^unhold on "app"/),
		);
	});

	test("a hold's lock says prune, which a 0.4 reader expires like any lock", async () => {
		const inner = local();
		const operations: unknown[] = [];
		const watching: Repository = {
			...inner,
			put: async (key, file) => {
				if (key.includes('/locks/')) {
					operations.push(JSON.parse(await Bun.file(file).text()).operation);
				}
				return inner.put(key, file);
			},
		};
		const backups = bound(watching);
		const [a] = await three(backups);
		operations.length = 0;
		await backups.hold(a);
		await backups.unhold(a);
		expect(new Set(operations)).toEqual(new Set(['prune']));
	});
});

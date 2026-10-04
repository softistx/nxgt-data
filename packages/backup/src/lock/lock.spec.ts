import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	folder,
	type KeyPair,
	keyPair,
	memorySource,
	streamOf,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { bindBackup } from '../backups/bind-backup';
import { defineBackup } from '../definition/define-backup';
import { BackupError } from '../errors/backup-error';
import { newBackupId } from '../format/ids';
import { localRepository } from '../repository/local';
import type { Repository } from '../repository/types';
import type { BackupSource } from '../source/types';
import { LOCK_FORMAT } from './lock';

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

function bound(repositories: [Repository, ...Repository[]], lease?: number) {
	return bindBackup(app, {
		repositories,
		recipients: [keys.recipient],
		tmpDir: root.path,
		...(lease === undefined ? {} : { lock: { lease } }),
	});
}

/** Plants a lock file as another writer would leave it. */
async function plant(
	repository: string,
	content: string | ((id: string) => object),
): Promise<string> {
	const id = newBackupId(new Date());
	const dir = join(root.path, repository, 'app', 'locks');
	await mkdir(dir, { recursive: true });
	const text =
		typeof content === 'string' ? content : JSON.stringify(content(id));
	await writeFile(join(dir, `${id}.json`), text);
	return id;
}

async function locksIn(repository: string): Promise<string[]> {
	return readdir(join(root.path, repository, 'app', 'locks')).catch(() => []);
}

/** A source whose one entry takes `ms` to read. */
function slowSource(ms: number): BackupSource {
	return {
		kind: 'memory',
		async *entries() {
			yield {
				name: 'slow',
				open: () =>
					new ReadableStream<Uint8Array>({
						async start(controller) {
							await Bun.sleep(ms);
							controller.enqueue(new TextEncoder().encode('late'));
							controller.close();
						},
					}),
			};
		},
	};
}

function errorOf(outcome: { stored: boolean; error?: unknown } | undefined) {
	return (outcome as { error?: unknown } | undefined)?.error;
}

describe('the lock', () => {
	test('is taken for the run and gone after it, success or not', async () => {
		const backups = bound([local()]);
		await backups.create(memorySource({ a: 'alpha' }));
		expect(await locksIn('local')).toEqual([]);
		const failing: BackupSource = {
			kind: 'memory',
			async *entries() {
				yield { name: 'a', open: () => streamOf('x') };
				throw new Error('source broke');
			},
		};
		await rejection(backups.create(failing));
		expect(await locksIn('local')).toEqual([]);
	});

	test('held by another writer refuses that repository, and the others go on', async () => {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const other = await plant('busy', (id) => ({
			format: LOCK_FORMAT,
			id,
			operation: 'prune',
			expiresAt,
		}));
		const backups = bound([local('free'), local('busy')]);
		const error = await rejection(backups.create(memorySource({ a: 'alpha' })));
		expect(error).toBeInstanceOf(BackupError);
		expect(error).toHaveProperty('code', 'PARTIAL');
		const [free, busy] = (error as BackupError).outcomes;
		expect(free?.stored).toBe(true);
		expect(errorOf(busy)).toHaveProperty('code', 'LOCKED');
		expect(errorOf(busy)).toHaveProperty(
			'message',
			'create on "app": another create or prune holds the lock (repository "busy")',
		);
		expect(await locksIn('busy')).toEqual([`${other}.json`]);
		expect((await backups.list({ from: 'busy' })).backups).toEqual([]);
	});

	test('one past its end by a whole lease is not held, and is removed', async () => {
		const stale = await plant('local', (id) => ({
			format: LOCK_FORMAT,
			id,
			operation: 'create',
			expiresAt: new Date(Date.now() - 2001).toISOString(),
		}));
		const backups = bound([local()], 2000);
		await backups.create(memorySource({ a: 'alpha' }));
		expect(await locksIn('local')).not.toContain(`${stale}.json`);
	});

	test('one just past its end is still held: the clocks may disagree', async () => {
		await plant('local', (id) => ({
			format: LOCK_FORMAT,
			id,
			operation: 'create',
			expiresAt: new Date(Date.now() - 500).toISOString(),
		}));
		const error = await rejection(
			bound([local()], 60_000).create(memorySource({ a: 'alpha' })),
		);
		expect(error).toHaveProperty('code', 'NOT_STORED');
		expect(errorOf((error as BackupError).outcomes[0])).toHaveProperty(
			'code',
			'LOCKED',
		);
	});

	test('one that does not read as a lock is held: nothing says when it ends', async () => {
		await plant('local', 'not a lock');
		const error = await rejection(
			bound([local()]).create(memorySource({ a: 'a' })),
		);
		expect(error).toHaveProperty('code', 'NOT_STORED');
	});

	test('two writers at once: never both', async () => {
		for (let round = 0; round < 10; round++) {
			const repository = local(`race-${round}`);
			const backups = bound([repository]);
			const results = await Promise.allSettled([
				backups.create(memorySource({ a: 'alpha' })),
				backups.create(memorySource({ b: 'beta' })),
			]);
			const stored = results.filter((r) => r.status === 'fulfilled').length;
			expect(stored).toBeLessThanOrEqual(1);
			for (const result of results) {
				if (result.status === 'rejected') {
					expect(result.reason).toHaveProperty('code', 'NOT_STORED');
				}
			}
			expect((await backups.list()).backups).toHaveLength(stored);
		}
	});

	test('is renewed while the run lasts longer than the lease', async () => {
		const created = await bound([local()], 1000).create(slowSource(2500));
		expect(created.outcomes).toEqual([{ repository: 'local', stored: true }]);
	});

	test('a lease that could not be renewed runs out, and nothing more is written', async () => {
		const inner = local();
		let lockPuts = 0;
		const flaky: Repository = {
			...inner,
			put: async (key, file) => {
				if (key.includes('/locks/') && ++lockPuts > 1) {
					throw new Error('the store is unreachable');
				}
				return inner.put(key, file);
			},
		};
		const error = await rejection(
			bound([flaky], 1000).create(slowSource(1500)),
		);
		expect(error).toHaveProperty('code', 'NOT_STORED');
		const lost = errorOf((error as BackupError).outcomes[0]);
		expect(lost).toHaveProperty('code', 'LEASE_LOST');
		expect(lost).toHaveProperty(
			'message',
			`create on "app": the lock's lease ran out before it was done (repository "local")`,
		);
		expect((await bound([inner]).list()).backups).toEqual([]);
	});

	test('a renewal that lands after the lease ran out does not bring it back', async () => {
		const inner = local();
		let lockPuts = 0;
		const slow: Repository = {
			...inner,
			put: async (key, file) => {
				// The first renewal starts at a third of the lease and lands
				// after its end, but before the end it asked for.
				if (key.includes('/locks/') && ++lockPuts === 2) await Bun.sleep(900);
				return inner.put(key, file);
			},
		};
		const error = await rejection(bound([slow], 1000).create(slowSource(2500)));
		expect(error).toHaveProperty('code', 'NOT_STORED');
		expect(errorOf((error as BackupError).outcomes[0])).toHaveProperty(
			'code',
			'LEASE_LOST',
		);
		// Lost, it stops renewing: one acquire and the one late renewal.
		expect(lockPuts).toBe(2);
		expect(await locksIn('local')).toEqual([]);
	});

	test('two repositories are locked and renewed side by side', async () => {
		const created = await bound([local('one'), local('two')], 1000).create(
			slowSource(2500),
		);
		expect(created.outcomes.every((outcome) => outcome.stored)).toBe(true);
		expect(await locksIn('one')).toEqual([]);
		expect(await locksIn('two')).toEqual([]);
	});

	test('a failure while looking for others leaves no lock of its own behind', async () => {
		const inner = local();
		const blind: Repository = {
			...inner,
			list: (prefix) =>
				prefix.endsWith('/locks/')
					? {
							[Symbol.asyncIterator]: () => ({
								next: () =>
									Promise.reject(new Error('the store is unreachable')),
							}),
						}
					: inner.list(prefix),
		};
		const error = await rejection(
			bound([blind]).create(memorySource({ a: 'a' })),
		);
		expect(errorOf((error as BackupError).outcomes[0])).toHaveProperty(
			'message',
			'the store is unreachable',
		);
		expect(await locksIn('local')).toEqual([]);
	});

	test('a lock put that rejected after it landed is removed all the same', async () => {
		const inner = local();
		const late: Repository = {
			...inner,
			put: async (key, file) => {
				await inner.put(key, file);
				if (key.includes('/locks/')) throw new Error('timed out');
			},
		};
		await rejection(bound([late]).create(memorySource({ a: 'a' })));
		expect(await locksIn('local')).toEqual([]);
	});

	test('a delete that throws does not stop the run from ending', async () => {
		const inner = local();
		const stubborn: Repository = {
			...inner,
			delete: () => {
				throw new Error('no delete here');
			},
		};
		const created = await bound([stubborn]).create(memorySource({ a: 'a' }));
		expect(created.outcomes).toEqual([{ repository: 'local', stored: true }]);
	});

	test('a stale lock a repository will not delete does not stop the run', async () => {
		await plant('local', (id) => ({
			format: LOCK_FORMAT,
			id,
			operation: 'create',
			expiresAt: new Date(Date.now() - 2001).toISOString(),
		}));
		const inner = local();
		const stubborn: Repository = {
			...inner,
			delete: (key) => {
				if (key.includes('/locks/')) throw new Error('no delete here');
				return inner.delete(key);
			},
		};
		const created = await bound([stubborn], 1000).create(
			memorySource({ a: 'a' }),
		);
		expect(created.outcomes).toEqual([{ repository: 'local', stored: true }]);
	});

	test('lock files are neither listed nor unreadable', async () => {
		const backups = bound([local()]);
		await plant('local', 'not a lock');
		const listing = await backups.list();
		expect(listing.backups).toEqual([]);
		expect(listing.unreadable).toEqual([]);
	});

	test('a lease out of range is refused at bind time', () => {
		for (const lease of [999, 86_400_001, 1.5, Number.NaN]) {
			expect(() => bound([local()], lease)).toThrow(
				'bindBackup: lock.lease must be a whole number of milliseconds, from 1 second to 1 day',
			);
		}
	});
});

describe('list, while a prune runs', () => {
	test('a manifest gone between the listing and the read is not listed', async () => {
		const inner = local();
		const backups = bound([inner]);
		const { id: gone } = await backups.create(memorySource({ a: 'alpha' }));
		const { id: kept } = await backups.create(memorySource({ b: 'beta' }));
		const racing: Repository = {
			...inner,
			get: async (key) => {
				if (key === `app/${gone}/manifest.json`) {
					await rm(join(root.path, 'local', 'app', gone), { recursive: true });
				}
				return inner.get(key);
			},
		};
		const listing = await bound([racing]).list();
		expect(listing.backups.map((b) => b.id)).toEqual([kept]);
		expect(listing.unreadable).toEqual([]);
	});
});

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { contents } from '../../test/fixtures';
import { startMongo, type TestServer } from '../../test/mongo';
import { rejection } from '../../test/rejection';
import { generateKeyFile } from './key-file';
import { mongoBackups } from './mongo-backups';
import { DEFAULT_FULL_EVERY } from './options';

let server: TestServer;
let folder: string;
let keyFile: string;

beforeAll(async () => {
	server = await startMongo();
});
afterAll(() => server.stop());
beforeEach(async () => {
	await server.reset();
	await server.client.db('restored').dropDatabase();
	folder = await mkdtemp(join(tmpdir(), 'nxgt-mongo-backups-'));
	keyFile = join(folder, 'backup.key');
	await generateKeyFile(keyFile);
});
afterEach(async () => {
	await server.clearFailures();
	await rm(folder, { recursive: true, force: true });
});

const restored = () => server.client.db('restored');
const backupsOf = (keep?: false) =>
	mongoBackups({
		db: server.db,
		repository: join(folder, 'repo'),
		keyFile,
		...(keep === false ? { keep } : {}),
	});

describe('mongoBackups', () => {
	test('rotates with keep, restores by id, replaces whole, backs up only collections', async () => {
		const backups = mongoBackups({
			db: server.db,
			repository: join(folder, 'repo'),
			keyFile,
			collections: ['kept'],
			keep: { last: 1 },
			fullEvery: 60 * 60 * 1000,
		});
		await server.db.collection('kept').insertOne({ n: 1 });
		await server.db.collection('left').insertOne({ n: 1 });
		const first = await backups.run();
		const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
		const second = await backups.run(later);
		expect(second.kind).toBe('full');
		expect(second.removed).toEqual([first.id]);
		expect((await backups.list()).map((b) => b.id)).toEqual([second.id]);

		await restored().collection('kept').insertOne({ n: 99 });
		const taken = await rejection(
			backups.restore({ into: restored(), at: second.id }),
		);
		expect(taken).toHaveProperty('code', 'EXISTS');
		expect(String((taken as Error).message)).toStartWith(
			`restore on "${server.db.databaseName}": a collection or view the backup holds`,
		);
		expect((taken as Error).cause).toHaveProperty('code', 'EXISTS');
		const back = await backups.restore({
			into: restored(),
			at: second.id,
			replace: true,
		});
		expect(back.id).toBe(second.id);
		expect(
			await restored()
				.collection('kept')
				.find<{ n: number }>({}, { projection: { _id: 0 } })
				.toArray(),
		).toEqual([{ n: 1 }]);
		expect(
			await restored().listCollections({ name: 'left' }).toArray(),
		).toEqual([]);
		// A part replaces too.
		await restored().collection('kept').insertOne({ n: 98 });
		await backups.restore({
			into: restored(),
			collections: ['kept'],
			replace: true,
		});
		expect(await restored().collection('kept').countDocuments()).toBe(1);
	});

	test('rotates by the clock, not the now run is given, and names restore in a part refused', async () => {
		const hour = 60 * 60 * 1000;
		const backups = mongoBackups({
			db: server.db,
			repository: join(folder, 'repo'),
			keyFile,
			keep: { within: hour },
			fullEvery: hour,
		});
		await server.db.collection('a').insertOne({ n: 1 });
		const first = await backups.run();
		// A later now makes a full backup, but never rotates away what it made.
		const later = await backups.run(new Date(Date.now() + 2 * hour));
		expect(later).toMatchObject({ kind: 'full', removed: [] });
		expect((await backups.list()).map((b) => b.id)).toEqual([
			first.id,
			later.id,
		]);
		expect(
			await rejection(backups.restore({ into: restored(), as: { a: '' } })),
		).toHaveProperty(
			'message',
			`restore on "${server.db.databaseName}": as must give a collection name`,
		);
	});

	test('runs a full backup, then incrementals, a full one on HISTORY_LOST, and a week on', async () => {
		const backups = backupsOf();
		await server.db.collection('orders').insertOne({ n: 1 });
		expect(await backups.run()).toMatchObject({
			kind: 'full',
			fellBack: false,
			chain: 1,
			removed: [],
		});
		await server.db.collection('orders').insertOne({ n: 2 });
		expect(await backups.run()).toMatchObject({
			kind: 'incremental',
			chain: 2,
		});
		await server.failNext(['aggregate'], { errorCode: 286 });
		expect(await backups.run()).toMatchObject({
			kind: 'full',
			fellBack: true,
			chain: 1,
		});
		// Any other failure is the run's: a full backup would hide it.
		const rest = { k: 'k'.repeat(200) };
		await server.db
			.collection('dotted')
			.insertOne({ _id: 1 as never, ...rest });
		await backups.run();
		await server.db.collection('dotted').updateOne({ _id: 1 as never }, [
			{
				$replaceWith: {
					$setField: { field: 'x.y', input: '$$ROOT', value: 5 },
				},
			},
		]);
		expect(await rejection(backups.run())).toHaveProperty(
			'code',
			'UNSUPPORTED',
		);
		await server.db.collection('dotted').drop();
		const later = new Date(Date.now() + DEFAULT_FULL_EVERY);
		expect(await backups.run(later)).toMatchObject({ kind: 'full', chain: 1 });
		expect(await backups.list()).toHaveLength(5);
		// Signed: a reader trusting the public key alone reads them.
		const { keys } = await backups.binding();
		const reader = bindBackup(defineBackup({ name: server.db.databaseName }), {
			repositories: [localRepository({ path: join(folder, 'repo') })],
			recipients: [keys.recipient],
			trusted: [keys.publicKey],
		});
		expect((await reader.list()).unreadable).toEqual([]);
	});

	test('restores the newest, one at a time, and part of one; a drill leaves nothing', async () => {
		const backups = backupsOf();
		const orders = server.db.collection('orders');
		await orders.insertOne({ _id: 1 as never, n: 1 });
		await server.db.createCollection('open', {
			viewOn: 'orders',
			pipeline: [],
		});
		const first = await backups.run();
		const between = new Date();
		await orders.insertOne({ n: 2 });
		await backups.run();

		await backups.restore({ into: restored() });
		expect(await contents(restored())).toEqual(await contents(server.db));

		await restored().dropDatabase();
		const back = await backups.restore({ into: restored(), at: between });
		expect(back.id).toBe(first.id);
		expect(back.collections).toBeUndefined();
		expect(await restored().collection('orders').countDocuments()).toBe(1);

		// `as` alone, or `documents` alone, is a part: restoreCollections.
		const part = await backups.restore({
			into: restored(),
			as: { orders: 'orders-now', open: 'open-now' },
		});
		expect(part.collections).toEqual([
			{ name: 'open', as: 'open-now' },
			{ name: 'orders', as: 'orders-now' },
		]);
		expect(await restored().collection('orders-now').countDocuments()).toBe(2);
		// A part's refusals name the call written: restore, not restoreCollections.
		expect(
			await rejection(backups.restore({ into: restored(), as: { nope: 'x' } })),
		).toHaveProperty(
			'message',
			`restore on "${server.db.databaseName}": as names a collection not restored`,
		);
		await restored().collection('orders').deleteMany({});
		const some = await backups.restore({
			into: restored(),
			documents: { filter: { _id: 1 }, existing: 'keep' },
		});
		expect(some.collections).toEqual([
			{ name: 'orders', as: 'orders', documents: 1 },
		]);

		expect(await backups.drill()).toMatchObject({
			collections: [{ name: 'orders', documents: 2 }],
		});
		const { databases } = await server.client
			.db('admin')
			.admin()
			.listDatabases();
		expect(databases.some((d) => /^nxgt-(drill|restore)-/.test(d.name))).toBe(
			false,
		);
	});

	test('keeps everything with keep: false, and finds nothing to restore before the first', async () => {
		const backups = backupsOf(false);
		const empty = await rejection(backups.restore({ into: restored() }));
		expect(empty).toHaveProperty('code', 'NOT_FOUND');
		expect(empty).toHaveProperty(
			'message',
			`restore on "${server.db.databaseName}": the repository holds no backup yet`,
		);
		await server.db.collection('a').insertOne({ n: 1 });
		for (let n = 0; n < 3; n++) {
			expect((await backups.run()).removed).toEqual([]);
		}
		const early = await rejection(
			backups.restore({ into: restored(), at: new Date(0) }),
		);
		expect(early).toHaveProperty(
			'message',
			`restore on "${server.db.databaseName}": no backup was made at or before that time`,
		);
	});

	test('refuses options it cannot use, and reads the key file again once fixed', async () => {
		const base = { db: server.db, repository: join(folder, 'repo'), keyFile };
		for (const [options, message] of [
			[{ db: {} }, 'mongoBackups: db must be a MongoDB Db'],
			[
				{ keyFile: 'backup.key' },
				'mongoBackups: keyFile must be an absolute path',
			],
			[
				{ repository: 'repo' },
				'mongoBackups: repository must be an absolute folder, or repositories',
			],
			[
				{ repository: undefined },
				'mongoBackups: repository must be an absolute folder, or repositories',
			],
			[
				{ repository: [{}] },
				'mongoBackups: repository must be an absolute folder, or repositories',
			],
			[
				{ repository: [] },
				'mongoBackups: repository must list repositories, each under a name of its own',
			],
			[
				{
					repository: [
						localRepository({ path: join(folder, 'a') }),
						localRepository({ path: join(folder, 'b') }),
					],
				},
				'mongoBackups: repository must list repositories, each under a name of its own',
			],
			[{ tmpDir: 'tmp' }, 'mongoBackups: tmpDir must be an absolute path'],
			[
				{ name: 'Shop' },
				'mongoBackups: name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"',
			],
			[
				{ db: server.client.db('MyShop') },
				`mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`,
			],
			[
				{ keep: {} },
				'mongoBackups: keep must be false, or name rules each a whole number, 1 or more',
			],
			[
				{ keep: { last: 0 } },
				'mongoBackups: keep must be false, or name rules each a whole number, 1 or more',
			],
			[
				{ fullEvery: 1000 },
				'mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more',
			],
		] as const) {
			expect(() => mongoBackups({ ...base, ...options } as never)).toThrow(
				message,
			);
		}
		const backups = mongoBackups(base);
		for (const [at, message] of [
			[
				{ into: server.client },
				`restore on "${server.db.databaseName}": into must be a MongoDB Db`,
			],
			[
				{ into: server.db, at: new Date('nope') },
				`restore on "${server.db.databaseName}": at must be a backup's id or a valid Date`,
			],
			[
				{
					into: server.db,
					documents: { filter: {}, existing: 'keep' },
					replace: true,
				},
				`restore on "${server.db.databaseName}": replace is for whole collections; documents says what happens to those there`,
			],
		] as const) {
			expect(await rejection(backups.restore(at as never))).toHaveProperty(
				'message',
				message,
			);
		}
		expect(await rejection(backups.run(new Date('nope')))).toHaveProperty(
			'message',
			`run on "${server.db.databaseName}": now must be a valid Date`,
		);
		expect(
			await rejection(mongoBackups({ ...base, name: 'x' }).drill()),
		).toHaveProperty(
			'message',
			'drill on "x": the repository holds no backup yet',
		);
		const missing = mongoBackups({
			...base,
			keyFile: join(folder, 'later.key'),
		});
		const none = await rejection(missing.list());
		expect(none).toHaveProperty('code', 'KEY_FILE');
		expect(none).toHaveProperty(
			'message',
			`mongoBackups on "${server.db.databaseName}": there is no key file there; write one with nxgt-mongo-backup keygen`,
		);
		expect((none as Error).cause).toHaveProperty('code', 'ENOENT');
		await generateKeyFile(join(folder, 'later.key'));
		expect(await missing.list()).toEqual([]);
	});
});

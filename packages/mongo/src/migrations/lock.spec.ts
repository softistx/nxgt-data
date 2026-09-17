import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { MongoClient } from 'mongodb';
import { startMongo, type TestServer } from '../../test/server';
import { DataError } from '../errors/data-error';
import { defineMigration } from './define-migration';
import { MigrationError, MigrationLockedError } from './errors';
import { migrate, rollback } from './run';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-migration-lock');
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

const lock = () =>
	t.db.collection<{ _id: string; holder?: string }>('nxgt_migrations_lock');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = defineMigration({ id: 'noop', up: async () => {} });

/** A migration that waits until it is let go. */
function gated() {
	let release = () => {};
	let started = () => {};
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const migration = defineMigration({
		id: 'slow',
		transaction: false,
		async up() {
			started();
			await gate;
		},
	});
	return { migration, running, release };
}

describe('the migration lock', () => {
	test('a held lock refuses another run, which runs nothing', async () => {
		const expiresAt = new Date(Date.now() + 60_000);
		await lock().insertOne({
			_id: 'lock',
			holder: 'elsewhere:1',
			acquiredAt: new Date(),
			expiresAt,
		} as never);
		const error = await migrate(t.db, [noop]).catch((e) => e);
		expect(error).toBeInstanceOf(MigrationLockedError);
		expect(error.code).toBe('MIGRATION_LOCKED');
		expect(error.holder).toBe('elsewhere:1');
		expect(error.expiresAt).toEqual(expiresAt);
		expect(error.message).toContain('locked by elsewhere:1 until');
		expect(await t.db.collection('nxgt_migrations').countDocuments()).toBe(0);
		await expect(rollback(t.db, [noop])).rejects.toBeInstanceOf(
			MigrationLockedError,
		);
	});

	test('an expired lock is taken over', async () => {
		await lock().insertOne({
			_id: 'lock',
			holder: 'crashed:1',
			acquiredAt: new Date(0),
			expiresAt: new Date(Date.now() - 1),
		} as never);
		expect((await migrate(t.db, [noop])).applied).toHaveLength(1);
	});

	test('a lock that cannot be taken is a DataError about the lock', async () => {
		await t.failNext(['aggregate'], { errorCode: 13 });
		const error = await migrate(t.db, [noop]).catch((e) => e);
		expect(error).toBeInstanceOf(DataError);
		expect(error).not.toBeInstanceOf(MigrationLockedError);
		expect(error.serverCode).toBe(13);
		expect(error.collection).toBe('nxgt_migrations_lock');
		expect(await t.db.collection('nxgt_migrations').countDocuments()).toBe(0);
	});

	test('a held lock that cannot be read back is a DataError too', async () => {
		await lock().insertOne({
			_id: 'lock',
			holder: 'elsewhere:1',
			expiresAt: new Date(Date.now() + 60_000),
		} as never);
		await t.failNext(['find'], { errorCode: 13 });
		const error = await migrate(t.db, [noop]).catch((e) => e);
		expect(error).toBeInstanceOf(DataError);
		expect(error.collection).toBe('nxgt_migrations_lock');
	});

	test('the lock is released after a run, and after a failure', async () => {
		await migrate(t.db, [noop]);
		expect(await lock().countDocuments()).toBe(0);
		const broken = defineMigration({
			id: 'broken',
			up: async () => {
				throw new Error('boom');
			},
		});
		await expect(migrate(t.db, [noop, broken])).rejects.toBeInstanceOf(
			MigrationError,
		);
		expect(await lock().countDocuments()).toBe(0);
	});

	test('two runs at once: one migrates, the other is refused', async () => {
		const { migration, running, release } = gated();
		const first = migrate(t.db, [migration]);
		await running;
		const second = await migrate(t.db, [migration]).catch((e) => e);
		expect(second).toBeInstanceOf(MigrationLockedError);
		release();
		expect((await first).applied.map((r) => r.id)).toEqual(['slow']);
		expect(await t.db.collection('nxgt_migrations').countDocuments()).toBe(1);
	});

	test('a run renews its lock while it works', async () => {
		const { migration, running, release } = gated();
		const first = migrate(t.db, [migration], { lockTtlMs: 1000 });
		await running;
		await sleep(1600);
		await expect(
			migrate(t.db, [migration], { lockTtlMs: 1000 }),
		).rejects.toBeInstanceOf(MigrationLockedError);
		release();
		await first;
	});

	test('a finished run stops renewing its lock', async () => {
		const watched = new MongoClient(t.uri, { monitorCommands: true });
		const renewals: string[] = [];
		watched.on('commandStarted', (event) => {
			if (event.commandName === 'update') renewals.push(event.commandName);
		});
		try {
			await migrate(watched.db(t.db.databaseName), [noop], {
				lockTtlMs: 1000,
			});
			const after = renewals.length;
			await sleep(800);
			expect(renewals.length).toBe(after);
		} finally {
			await watched.close();
		}
	});

	test('a run that lost its lock stops before the next migration', async () => {
		let ranAfter = false;
		const stolen = defineMigration({
			id: 'stolen',
			transaction: false,
			async up() {
				// Another run took the lock over, as it would after an expiry.
				await lock().updateOne({ _id: 'lock' }, { $set: { holder: 'thief' } });
				await sleep(700);
			},
		});
		const after = defineMigration({
			id: 'after',
			up: async () => {
				ranAfter = true;
			},
		});
		const error = await migrate(t.db, [stolen, after], {
			lockTtlMs: 1000,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(MigrationLockedError);
		expect(error.message).toContain('lost its migration lock');
		expect(ranAfter).toBe(false);
		// It does not release a lock that is no longer its own.
		expect((await lock().findOne({ _id: 'lock' }))?.holder).toBe('thief');
	});

	test.each([0, 999, 1.5, Number.NaN])(
		'refuses a lockTtlMs of %p',
		async (lockTtlMs) => {
			await expect(migrate(t.db, [noop], { lockTtlMs })).rejects.toThrow(
				'lockTtlMs must be a whole number of milliseconds, at least 1000',
			);
		},
	);
});

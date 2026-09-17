import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { ClientSession } from 'mongodb';
import { startMongo, type TestServer } from '../../test/server';
import { DataError } from '../errors/data-error';
import { defineMigration } from './define-migration';
import { MigrationError } from './errors';
import { migrate, migrationStatus, rollback } from './run';
import type { Migration, MigrationContext } from './types';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo('nxgt-migrations');
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

const posts = () => t.db.collection<{ _id: number; slug?: string }>('posts');
const recordIds = async (name = 'nxgt_migrations') =>
	(await t.db.collection<{ _id: string }>(name).find().toArray()).map(
		(r) => r._id,
	);

/** A migration that writes one post, and removes it on the way down. */
function writes(id: string, post: number, transaction = true): Migration {
	return defineMigration({
		id,
		transaction,
		async up({ db, session }) {
			await db
				.collection('posts')
				.insertOne({ _id: post } as never, { session });
		},
		async down({ db, session }) {
			await db
				.collection('posts')
				.deleteOne({ _id: post } as never, { session });
		},
	});
}

const list = [writes('one', 1), writes('two', 2), writes('three', 3)];

describe('migrate', () => {
	test('applies the list in order, and records each one', async () => {
		const result = await migrate(t.db, list);
		expect(result.applied.map((r) => r.id)).toEqual(['one', 'two', 'three']);
		expect(result.pending).toEqual([]);
		for (const run of result.applied) {
			expect(run.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(await posts().countDocuments()).toBe(3);
		const records = await t.db
			.collection<{ _id: string; appliedAt: Date }>('nxgt_migrations')
			.find()
			.toArray();
		expect(records.map((r) => r._id)).toEqual(['one', 'two', 'three']);
		expect(records[0]?.appliedAt).toBeInstanceOf(Date);
	});

	test('a second run applies nothing, and a grown list only the new one', async () => {
		await migrate(t.db, list.slice(0, 2));
		expect((await migrate(t.db, list.slice(0, 2))).applied).toEqual([]);
		const grown = await migrate(t.db, list);
		expect(grown.applied.map((r) => r.id)).toEqual(['three']);
	});

	test('`to` stops after the one it names', async () => {
		const result = await migrate(t.db, list, { to: 'two' });
		expect(result.applied.map((r) => r.id)).toEqual(['one', 'two']);
		expect(await recordIds()).toEqual(['one', 'two']);
	});

	test('a dry run reports and changes nothing, not even the collection', async () => {
		const result = await migrate(t.db, list, { dryRun: true });
		expect(result).toEqual({ applied: [], pending: ['one', 'two', 'three'] });
		const names = (await t.db.listCollections().toArray()).map((c) => c.name);
		expect(names).toEqual([]);
	});

	test('a migration is handed the database, the client and its session', async () => {
		const seen: MigrationContext[] = [];
		const inTransaction: boolean[] = [];
		const look = (id: string, transaction: boolean) =>
			defineMigration({
				id,
				transaction,
				async up(context) {
					seen.push(context);
					inTransaction.push(
						(context.session as ClientSession | undefined)?.inTransaction() ??
							false,
					);
				},
			});
		await migrate(t.db, [look('in', true), look('out', false)]);
		expect(seen[0]?.db).toBe(t.db);
		expect(seen[0]?.client).toBe(t.db.client);
		expect(inTransaction).toEqual([true, false]);
		expect(seen[1]?.session).toBeUndefined();
	});

	test('a failure keeps nothing of that migration, and stops the run', async () => {
		const failing = defineMigration({
			id: 'broken',
			async up({ db, session }) {
				await db
					.collection('posts')
					.insertOne({ _id: 9 } as never, { session });
				throw new Error('boom');
			},
		});
		const error = await migrate(t.db, [
			list[0] as Migration,
			failing,
			list[1] as Migration,
		]).catch((e) => e);
		expect(error).toBeInstanceOf(MigrationError);
		expect(error.migration).toBe('broken');
		expect(error.message).toBe(
			'Migration "broken" failed up, and nothing it did was kept: boom',
		);
		expect(error.cause).toBeInstanceOf(Error);
		// The one before stays applied; the failed one left no trace.
		expect(await recordIds()).toEqual(['one']);
		expect((await posts().find().toArray()).map((p) => p._id)).toEqual([1]);
	});

	test('without a transaction, what ran before the failure stays', async () => {
		const failing = defineMigration({
			id: 'half',
			transaction: false,
			async up({ db }) {
				await db.collection('posts').insertOne({ _id: 9 } as never);
				throw new Error('boom');
			},
		});
		await expect(migrate(t.db, [failing])).rejects.toThrow(
			'it ran without a transaction, so what it did before failing stays: boom',
		);
		expect(await recordIds()).toEqual([]);
		expect(await posts().countDocuments()).toBe(1);
	});

	test('a commit that fails keeps neither the migration nor its record', async () => {
		await t.failNext(['commitTransaction'], { errorCode: 2 });
		await expect(migrate(t.db, list.slice(0, 1))).rejects.toThrow(
			'Migration "one" failed up, and nothing it did was kept',
		);
		expect(await recordIds()).toEqual([]);
		expect(await posts().countDocuments()).toBe(0);

		await migrate(t.db, list.slice(0, 1));
		await t.failNext(['commitTransaction'], { errorCode: 2 });
		await expect(rollback(t.db, list.slice(0, 1))).rejects.toThrow(
			'failed down',
		);
		expect(await recordIds()).toEqual(['one']);
		expect(await posts().countDocuments()).toBe(1);
	});

	test('a list edited under an applied database is refused before anything runs', async () => {
		await migrate(t.db, list.slice(0, 1));
		await expect(migrate(t.db, list.slice(1))).rejects.toThrow(
			'Migration "one" is recorded as applied and is no longer in the list',
		);
		await expect(
			migrate(t.db, [list[1] as Migration, list[0] as Migration]),
		).rejects.toThrow('Migration "two" is pending and listed before');
		expect(await posts().countDocuments()).toBe(1);
	});

	test('a records collection that cannot be created stops the run', async () => {
		await t.failNext(['create'], { errorCode: 13 });
		const error = await migrate(t.db, list).catch((e) => e);
		expect(error).toBeInstanceOf(DataError);
		expect(error.serverCode).toBe(13);
		expect(error.collection).toBe('nxgt_migrations');
		expect(await posts().countDocuments()).toBe(0);
	});

	test('the records can live elsewhere', async () => {
		await migrate(t.db, list.slice(0, 1), { collection: 'schema_history' });
		expect(await recordIds('schema_history')).toEqual(['one']);
		const names = (await t.db.listCollections().toArray()).map((c) => c.name);
		expect(names).not.toContain('nxgt_migrations');
		expect(
			(await migrationStatus(t.db, list, { collection: 'schema_history' }))[0]
				?.state,
		).toBe('applied');
	});
});

describe('rollback', () => {
	test('undoes the last applied migration, and its record', async () => {
		await migrate(t.db, list);
		const result = await rollback(t.db, list);
		expect(result.reverted.map((r) => r.id)).toEqual(['three']);
		expect(await recordIds()).toEqual(['one', 'two']);
		expect(await posts().countDocuments()).toBe(2);
	});

	test('`to` undoes every one after it, the last first', async () => {
		const order: string[] = [];
		const tracked = list.map((migration) =>
			defineMigration({
				...migration,
				async down(context) {
					order.push(migration.id);
					await migration.down?.(context);
				},
			}),
		);
		await migrate(t.db, tracked);
		const result = await rollback(t.db, tracked, { to: 'one' });
		expect(result.reverted.map((r) => r.id)).toEqual(['three', 'two']);
		expect(order).toEqual(['three', 'two']);
		expect(await recordIds()).toEqual(['one']);
		// And back up again.
		expect((await migrate(t.db, tracked)).applied).toHaveLength(2);
	});

	test('a dry run reports and undoes nothing', async () => {
		await migrate(t.db, list);
		expect(await rollback(t.db, list, { to: 'one', dryRun: true })).toEqual({
			reverted: [],
			pending: ['three', 'two'],
		});
		expect(await recordIds()).toHaveLength(3);
	});

	test('with nothing applied, there is nothing to undo', async () => {
		expect(await rollback(t.db, list)).toEqual({ reverted: [], pending: [] });
	});

	test('a migration with no down refuses the whole rollback', async () => {
		const oneWay = defineMigration({ id: 'one-way', up: async () => {} });
		const mixed = [list[0] as Migration, oneWay, list[1] as Migration];
		await migrate(t.db, mixed);
		await expect(rollback(t.db, mixed, { to: 'one' })).rejects.toThrow(
			'Migration "one-way" has no down',
		);
		expect(await recordIds()).toHaveLength(3);
		expect(await posts().countDocuments()).toBe(2);
	});

	test('a failing down keeps the record, and the data', async () => {
		const stuck = defineMigration({
			id: 'stuck',
			up: async () => {},
			async down({ db, session }) {
				await db.collection('posts').deleteMany({}, { session });
				throw new Error('nope');
			},
		});
		await migrate(t.db, [list[0] as Migration, stuck]);
		await expect(rollback(t.db, [list[0] as Migration, stuck])).rejects.toThrow(
			'Migration "stuck" failed down, and nothing it did was kept: nope',
		);
		expect(await recordIds()).toEqual(['one', 'stuck']);
		expect(await posts().countDocuments()).toBe(1);
	});
});

describe('migrationStatus', () => {
	test('reports rather than refuses', async () => {
		await migrate(t.db, list.slice(0, 2));
		const status = await migrationStatus(t.db, [
			list[1] as Migration,
			list[2] as Migration,
		]);
		expect(status.map(({ id, state }) => ({ id, state }))).toEqual([
			{ id: 'two', state: 'applied' },
			{ id: 'three', state: 'pending' },
			{ id: 'one', state: 'missing' },
		]);
		expect(status[0]?.appliedAt).toBeInstanceOf(Date);
	});

	test('a list with an id twice is still refused', async () => {
		await expect(
			migrationStatus(t.db, [list[0] as Migration, list[0] as Migration]),
		).rejects.toThrow('listed twice');
	});
});

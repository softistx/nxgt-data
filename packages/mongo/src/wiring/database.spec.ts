import { beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import { rejection } from '../../test/rejection';
import { collections, events, useMongo } from '../../test/wiring';
import { resetAutoSync } from '../collection/auto-sync';
import { WiringError } from '../errors/wiring-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-database');

// `server.reset` empties the server's own database only: the derived ones are dropped here.
beforeEach(async () => {
	const client = await MongoClient.connect(server.uri);
	try {
		for (const name of ['tenant_a', 'tenant_b']) {
			await client.db(name).dropDatabase();
		}
	} finally {
		await client.close();
	}
	// The dropped databases are no longer in shape, whatever autoSync remembers.
	resetAutoSync();
});

const plainMongo = async (more: { autoSync?: boolean } = {}) =>
	track(
		await openMongo(defineMongo({ uri: server.uri, collections, ...more })),
	);

describe('database', () => {
	test('derives, with no await, a Mongo on another database of the same client', async () => {
		const mongo = await plainMongo();
		const tenant = mongo.database('tenant_a');
		expect(tenant.clients.default).toBe(mongo.clients.default);
		expect(tenant.db.databaseName).toBe('tenant_a');
		await tenant.db.users.create({ email: 'ada@example.com' });
		expect(await tenant.db.users.count()).toBe(1);
		expect(await mongo.db.users.count()).toBe(0);
		expect(await mongo.database('tenant_b').db.users.count()).toBe(0);
	});

	test('carries the actor and the session', async () => {
		const mongo = await plainMongo();
		const actor = new ObjectId();
		const session = mongo.clients.default.startSession();
		try {
			const tenant = mongo.as(actor).withSession(session).database('tenant_a');
			expect(tenant.actor).toEqual(actor);
			expect(tenant.session).toBe(session);
			const user = await tenant.db.users.create({ email: 'ada@example.com' });
			expect(user.createdBy).toEqual(actor);
		} finally {
			await session.endSession();
		}
	});

	test('joins the transaction it was derived in', async () => {
		const mongo = await plainMongo({ autoSync: true });
		const rolledBack = await rejection(
			mongo.transaction(async (tx) => {
				await tx
					.database('tenant_a')
					.db.users.create({ email: 'a@example.com' });
				throw new Error('rollback');
			}),
		);
		expect(rolledBack).toHaveProperty('message', 'rollback');
		expect(await mongo.database('tenant_a').db.users.count()).toBe(0);
		await mongo.transaction(async (tx) => {
			await tx.database('tenant_a').db.users.create({ email: 'a@example.com' });
		});
		expect(await mongo.database('tenant_a').db.users.count()).toBe(1);
	});

	test('a never-synced database has no indexes, even after a write in a transaction', async () => {
		const mongo = await plainMongo();
		await mongo.transaction(async (tx) => {
			await tx.database('tenant_a').db.users.create({ email: 'a@b.c' });
		});
		const raw = mongo.database('tenant_a').db.collection('users');
		expect((await raw.indexes()).map((index) => index.name)).toEqual(['_id_']);
		// Synced, the unique index is there and enforced.
		await mongo.database('tenant_a').sync();
		const error = await rejection(
			mongo.database('tenant_a').db.users.create({ email: 'a@b.c' }),
		);
		expect(error).toHaveProperty('name', 'ConflictError');
	});

	test('builds its own collections, and keeps autoSync', async () => {
		const mongo = await plainMongo({ autoSync: true });
		const tenant = mongo.database('tenant_a');
		expect(tenant.db.users).toBe(tenant.db.users);
		expect(tenant.db.users).not.toBe(mongo.db.users);
		await tenant.db.users.count();
		const names = await tenant.db.listCollections().toArray();
		expect(names.map((c) => c.name)).toContain('users');
	});

	test('syncs a tenant database once, however often it is derived', async () => {
		const mongo = await plainMongo({ autoSync: true });
		await mongo.database('tenant_a').db.users.count();
		const raw = mongo.database('tenant_a').db.collection('users');
		await raw.dropIndexes();
		// A new derivation, so a new `Db`: it must find the sync already done.
		await mongo.database('tenant_a').db.users.count();
		await mongo.as(new ObjectId()).database('tenant_a').db.users.count();
		const indexes = await raw.indexes();
		expect(indexes.map((index) => index.name)).toEqual(['_id_']);
	});

	test('can derive again, and sync explicitly', async () => {
		const mongo = await plainMongo();
		const tenant = mongo.database('tenant_a').database('tenant_b');
		expect(tenant.db.databaseName).toBe('tenant_b');
		const reports = await tenant.sync();
		expect(reports.default.length).toBeGreaterThan(0);
	});

	test('leaves the client open, and cannot be closed', async () => {
		const mongo = await plainMongo();
		const tenant = mongo.database('tenant_a');
		const error = await tenant.close().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'DERIVED');
		expect(await mongo.db.users.count()).toBe(0);
	});

	test.each([
		['an empty name', ''],
		['a slash', 'a/b'],
		['a dot', 'a.b'],
		['a space', 'a b'],
		['a dollar', 'a$b'],
		['a NUL', 'a\0b'],
		['64 bytes', 'x'.repeat(64)],
		['a reserved name', 'admin'],
		['another reserved name', 'local'],
		['the last reserved name', 'config'],
	])('refuses %s with DATABASE_NAME, and not its value', async (_, name) => {
		const mongo = await plainMongo();
		let error: unknown;
		try {
			mongo.database(name);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'DATABASE_NAME');
		if (name.length > 0 && !['admin', 'local', 'config'].includes(name)) {
			expect((error as Error).message).not.toContain(name);
		}
	});

	test('refuses a name that is not a string', async () => {
		const mongo = await plainMongo();
		const loose = mongo as unknown as { database(name: unknown): unknown };
		expect(() => loose.database(42)).toThrow(
			expect.objectContaining({ code: 'DATABASE_NAME' }),
		);
	});

	test("merges `options` and `optionsFor` over the source's", async () => {
		const mongo = await plainMongo();
		const bad = { email: 42 } as never;
		await rejection(mongo.db.users.create(bad)); // `parse` by default
		const lax = mongo.database('tenant_a', { options: { validate: 'off' } });
		await lax.db.users.create(bad);
		expect(await lax.db.users.count()).toBe(1);
		// `optionsFor` wins over `options`, for its key only.
		const mixed = mongo.database('tenant_b', {
			options: { validate: 'off' },
			optionsFor: { users: { validate: 'parse' } },
		});
		expect(await rejection(mixed.db.users.create(bad))).toBeInstanceOf(Error);
		await mixed.db.posts.create({ title: 42 } as never);
		// And the Mongo it came from keeps its own.
		expect(await mongo.db.users.count()).toBe(0);
	});

	test('refuses what the wiring decides, and a key nothing wires', async () => {
		const mongo = await plainMongo();
		const loose = mongo as unknown as {
			database(name: string, options: object): unknown;
		};
		for (const options of [
			{ options: { autoSync: true } },
			{ options: { session: null } },
			{ optionsFor: { users: { actor: 1 } } },
			{ optionsFor: { nowhere: {} } },
		]) {
			expect(() => loose.database('tenant_a', options)).toThrow(
				expect.objectContaining({ code: 'CONFIG' }),
			);
		}
	});

	describe('with several databases', () => {
		const several = async () =>
			track(
				await openMongo(
					defineMongo({
						databases: {
							main: { uri: server.uri, collections },
							analytics: {
								uri: server.uri,
								database: 'wiring-database-analytics',
								collections: { events },
							},
						},
					}),
				),
			);

		test('takes the collections of `from`', async () => {
			const mongo = await several();
			const tenant = mongo.database('tenant_a', { from: 'analytics' });
			expect(tenant.db.databaseName).toBe('tenant_a');
			await tenant.db.events.count();
			expect(Object.keys(tenant.db)).toEqual(['events']);
		});

		test('refuses to guess, and an unknown `from`', async () => {
			const mongo = await several();
			const loose = mongo as unknown as {
				database(name: string, options?: { from?: string }): unknown;
			};
			expect(() => loose.database('t')).toThrow(
				expect.objectContaining({ code: 'SEVERAL_DATABASES' }),
			);
			expect(() => loose.database('t', { from: 'nope' })).toThrow(
				expect.objectContaining({ code: 'NO_DATABASE' }),
			);
		});
	});
});

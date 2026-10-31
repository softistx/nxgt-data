import { beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import { collections, events, useMongo } from '../../test/wiring';
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
		const mongo = await plainMongo();
		// mongod cannot create a collection inside a transaction on a fresh database.
		await mongo.database('tenant_a').db.createCollection('users');
		await expect(
			mongo.transaction(async (tx) => {
				await tx
					.database('tenant_a')
					.db.users.create({ email: 'a@example.com' });
				throw new Error('rollback');
			}),
		).rejects.toThrow('rollback');
		expect(await mongo.database('tenant_a').db.users.count()).toBe(0);
		await mongo.transaction(async (tx) => {
			await tx.database('tenant_a').db.users.create({ email: 'a@example.com' });
		});
		expect(await mongo.database('tenant_a').db.users.count()).toBe(1);
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

	test('refuses an empty name', async () => {
		const mongo = await plainMongo();
		expect(() => mongo.database('')).toThrow(WiringError);
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
			expect(() => loose.database('t')).toThrow(WiringError);
			expect(() => loose.database('t', { from: 'nope' })).toThrow(WiringError);
		});
	});
});

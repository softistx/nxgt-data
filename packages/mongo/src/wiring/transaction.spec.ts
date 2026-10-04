import { describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import { rejectionMessage } from '../../test/rejection';
import { collections, events, useMongo } from '../../test/wiring';
import { WiringError } from '../errors/wiring-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-transaction');

const plainMongo = async () =>
	track(await openMongo(defineMongo({ uri: server.uri, collections })));

describe('transaction', () => {
	test('commits what it wrote', async () => {
		const mongo = await plainMongo();
		const written = await mongo.transaction(async (tx) => {
			await tx.db.users.create({ email: 'ada@example.com' });
			return tx.db.posts.create({ title: 'a' });
		});
		expect(written.title).toBe('a');
		expect(await mongo.db.users.count()).toBe(1);
		expect(await mongo.db.posts.count()).toBe(1);
	});

	test('rolls back everything when the body throws', async () => {
		const mongo = await plainMongo();
		expect(
			await rejectionMessage(
				mongo.transaction(async (tx) => {
					await tx.db.users.create({ email: 'ada@example.com' });
					throw new Error('no');
				}),
			),
		).toContain('no');
		expect(await mongo.db.users.count()).toBe(0);
	});

	test('gives the body a Mongo in the session', async () => {
		const mongo = await plainMongo();
		await mongo.transaction(async (tx) => {
			expect(tx.session).toBeDefined();
			expect(tx.session?.inTransaction()).toBe(true);
			// The Mongo it came from is not in it.
			expect(mongo.session).toBeUndefined();
		});
	});

	test('keeps the actor the Mongo was stamping', async () => {
		const mongo = await plainMongo();
		const actor = new ObjectId();
		const user = await mongo
			.as(actor)
			.transaction((tx) => tx.db.users.create({ email: 'ada@example.com' }));
		expect(user.createdBy).toEqual(actor);
	});

	test('takes the options it is given', async () => {
		const mongo = await plainMongo();
		const written = await mongo.transaction(
			(tx) => tx.db.users.create({ email: 'ada@example.com' }),
			{ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
		);
		expect(written.email).toBe('ada@example.com');
	});

	test('joins the transaction it is already in', async () => {
		const mongo = await plainMongo();
		expect(
			await rejectionMessage(
				mongo.transaction(async (outer) => {
					await outer.db.users.create({ email: 'ada@example.com' });
					await outer.transaction(async (inner) => {
						expect(inner.session).toBe(outer.session);
						await inner.db.posts.create({ title: 'a' });
					});
					// MongoDB has no savepoints: the outer failure takes both.
					throw new Error('no');
				}),
			),
		).toContain('no');
		expect(await mongo.db.users.count()).toBe(0);
		expect(await mongo.db.posts.count()).toBe(0);
	});

	test('refuses `on` once it is in a session', async () => {
		const mongo = await plainMongo();
		const error = await mongo
			.transaction((outer) =>
				outer.transaction(async () => undefined, { on: 'default' }),
			)
			.then(null, (reason: unknown) => reason);
		expect(error).toHaveProperty(
			'message',
			expect.stringContaining('already in a session'),
		);
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'TRANSACTION');
	});

	describe('with several databases', () => {
		const twoOnOneClient = () =>
			defineMongo({
				databases: {
					main: { uri: server.uri, collections },
					analytics: {
						uri: server.uri,
						database: 'wiring-transaction-analytics',
						collections: { events },
					},
				},
			});

		test('runs on the one client they share', async () => {
			const mongo = track(await openMongo(twoOnOneClient()));
			await mongo.transaction(async (tx) => {
				await tx.databases.main.users.create({ email: 'ada@example.com' });
				await tx.databases.analytics.events.create({ kind: 'signup' });
			});
			expect(await mongo.databases.main.users.count()).toBe(1);
			expect(await mongo.databases.analytics.events.count()).toBe(1);
			await mongo.clients.analytics
				.db('wiring-transaction-analytics')
				.dropDatabase();
		});

		test('takes the client `on` names', async () => {
			const mongo = track(await openMongo(twoOnOneClient()));
			const written = await mongo.transaction(
				(tx) => tx.databases.main.users.create({ email: 'ada@example.com' }),
				{ on: 'analytics' },
			);
			expect(written.email).toBe('ada@example.com');
		});

		test('refuses a database it does not have', async () => {
			const mongo = track(await openMongo(twoOnOneClient()));
			await expect(
				await rejectionMessage(
					mongo.transaction(async () => undefined, { on: 'nowhere' as never }),
				),
			).toContain('No database "nowhere" in this Mongo');
			const error = await mongo
				.transaction(async () => undefined, { on: 'nowhere' as never })
				.then(null, (reason: unknown) => reason);
			expect(error).toBeInstanceOf(WiringError);
			expect(error).toHaveProperty('code', 'NO_DATABASE');
			expect(error).toHaveProperty('database', 'nowhere');
		});

		test('refuses to choose between two clients', async () => {
			const other = new MongoClient(server.uri);
			await other.connect();
			const mongo = track(
				await openMongo(
					defineMongo({
						databases: {
							main: { uri: server.uri, collections },
							analytics: {
								client: other,
								database: 'wiring-transaction-analytics',
								collections: { events },
							},
						},
					}),
				),
			);
			try {
				await expect(
					await rejectionMessage(mongo.transaction(async () => undefined)),
				).toContain('holds more than one client');
				// Named, it runs — on that client's database alone.
				await mongo.transaction(
					(tx) => tx.databases.main.users.create({ email: 'ada@example.com' }),
					{ on: 'main' },
				);
				// The other database is on another client, and the driver refuses
				// its session: a transaction reaches one client's databases.
				await expect(
					await rejectionMessage(
						mongo.transaction(
							(tx) => tx.databases.analytics.events.create({ kind: 'signup' }),
							{ on: 'main' },
						),
					),
				).toContain('same MongoClient');
			} finally {
				await other.close();
			}
		});
	});
});

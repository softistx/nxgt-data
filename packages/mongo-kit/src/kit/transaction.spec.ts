import { describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import { collections, events, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-transaction');

const plainKit = async () =>
	track(await createKit(defineConfig({ uri: server.uri, collections })));

describe('transaction', () => {
	test('commits what it wrote', async () => {
		const kit = await plainKit();
		const written = await kit.transaction(async (tx) => {
			await tx.db.users.create({ email: 'ada@example.com' });
			return tx.db.posts.create({ title: 'a' });
		});
		expect(written.title).toBe('a');
		expect(await kit.db.users.count()).toBe(1);
		expect(await kit.db.posts.count()).toBe(1);
	});

	test('rolls back everything when the body throws', async () => {
		const kit = await plainKit();
		await expect(
			kit.transaction(async (tx) => {
				await tx.db.users.create({ email: 'ada@example.com' });
				throw new Error('no');
			}),
		).rejects.toThrow('no');
		expect(await kit.db.users.count()).toBe(0);
	});

	test('gives the body a kit in the session', async () => {
		const kit = await plainKit();
		await kit.transaction(async (tx) => {
			expect(tx.session).toBeDefined();
			expect(tx.session?.inTransaction()).toBe(true);
			// The kit it came from is not in it.
			expect(kit.session).toBeUndefined();
		});
	});

	test('keeps the actor the kit was stamping', async () => {
		const kit = await plainKit();
		const actor = new ObjectId();
		const user = await kit
			.as(actor)
			.transaction((tx) => tx.db.users.create({ email: 'ada@example.com' }));
		expect(user.createdBy).toEqual(actor);
	});

	test('takes the options it is given', async () => {
		const kit = await plainKit();
		const written = await kit.transaction(
			(tx) => tx.db.users.create({ email: 'ada@example.com' }),
			{ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
		);
		expect(written.email).toBe('ada@example.com');
	});

	test('joins the transaction it is already in', async () => {
		const kit = await plainKit();
		await expect(
			kit.transaction(async (outer) => {
				await outer.db.users.create({ email: 'ada@example.com' });
				await outer.transaction(async (inner) => {
					expect(inner.session).toBe(outer.session);
					await inner.db.posts.create({ title: 'a' });
				});
				// MongoDB has no savepoints: the outer failure takes both.
				throw new Error('no');
			}),
		).rejects.toThrow('no');
		expect(await kit.db.users.count()).toBe(0);
		expect(await kit.db.posts.count()).toBe(0);
	});

	test('refuses `on` once it is in a session', async () => {
		const kit = await plainKit();
		await expect(
			kit.transaction((outer) =>
				outer.transaction(async () => undefined, { on: 'default' }),
			),
		).rejects.toThrow('already in a session');
	});

	describe('with several databases', () => {
		const twoOnOneClient = () =>
			defineConfig({
				databases: {
					main: { uri: server.uri, collections },
					analytics: {
						uri: server.uri,
						database: 'kit-transaction-analytics',
						collections: { events },
					},
				},
			});

		test('runs on the one client they share', async () => {
			const kit = track(await createKit(twoOnOneClient()));
			await kit.transaction(async (tx) => {
				await tx.databases.main.users.create({ email: 'ada@example.com' });
				await tx.databases.analytics.events.create({ kind: 'signup' });
			});
			expect(await kit.databases.main.users.count()).toBe(1);
			expect(await kit.databases.analytics.events.count()).toBe(1);
			await kit.clients.analytics
				.db('kit-transaction-analytics')
				.dropDatabase();
		});

		test('takes the client `on` names', async () => {
			const kit = track(await createKit(twoOnOneClient()));
			const written = await kit.transaction(
				(tx) => tx.databases.main.users.create({ email: 'ada@example.com' }),
				{ on: 'analytics' },
			);
			expect(written.email).toBe('ada@example.com');
		});

		test('refuses a database it does not have', async () => {
			const kit = track(await createKit(twoOnOneClient()));
			await expect(
				kit.transaction(async () => undefined, { on: 'nowhere' as never }),
			).rejects.toThrow('has no database "nowhere"');
		});

		test('refuses to choose between two clients', async () => {
			const other = new MongoClient(server.uri);
			await other.connect();
			const kit = track(
				await createKit(
					defineConfig({
						databases: {
							main: { uri: server.uri, collections },
							analytics: {
								client: other,
								database: 'kit-transaction-analytics',
								collections: { events },
							},
						},
					}),
				),
			);
			try {
				await expect(kit.transaction(async () => undefined)).rejects.toThrow(
					'holds more than one client',
				);
				// Named, it runs — on that client's database alone.
				await kit.transaction(
					(tx) => tx.databases.main.users.create({ email: 'ada@example.com' }),
					{ on: 'main' },
				);
				// The other database is on another client, and the driver refuses
				// its session: a transaction reaches one client's databases.
				await expect(
					kit.transaction(
						(tx) => tx.databases.analytics.events.create({ kind: 'signup' }),
						{ on: 'main' },
					),
				).rejects.toThrow('same MongoClient');
			} finally {
				await other.close();
			}
		});
	});
});

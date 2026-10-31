import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { collections, useMongo } from '../../test/wiring';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-scope');

/** A Mongo on the test server, closed after the file. */
const plainMongo = async () =>
	track(await openMongo(defineMongo({ uri: server.uri, collections })));

const threeUsers = [
	{ email: 'a@example.com' },
	{ email: 'b@example.com' },
	{ email: 'c@example.com' },
];

describe('the scope', () => {
	test('gives the same collection back at every read', async () => {
		const mongo = await plainMongo();
		expect(mongo.db.users).toBe(mongo.db.users);
	});

	test('builds each collection on its own', async () => {
		const mongo = await plainMongo();
		const users = mongo.db.users;
		expect(mongo.db.posts).not.toBe(users);
		expect(mongo.db.users).toBe(users);
	});

	test('lists its collections, and not the driver`s members', async () => {
		const mongo = await plainMongo();
		expect(Object.keys(mongo.db)).toEqual(['users', 'posts']);
	});

	test('answers `in` for its collections and for the driver`s members', async () => {
		const mongo = await plainMongo();
		expect('users' in mongo.db).toBe(true);
		expect('command' in mongo.db).toBe(true);
		expect('nothing' in mongo.db).toBe(false);
	});

	test('binds the driver`s methods to the Db', async () => {
		const mongo = await plainMongo();
		const list = mongo.db.listCollections.bind(mongo.db);
		expect(await list().toArray()).toBeArray();
		const { command } = mongo.db;
		expect(await command({ ping: 1 })).toMatchObject({ ok: 1 });
	});

	test('passes the options the config set for every collection', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
					uri: server.uri,
					collections,
					options: { maxPageSize: 2 },
				}),
			),
		);
		await mongo.db.users.createMany(threeUsers);
		const page = await mongo.db.users.paginate({ pageSize: 3 });
		expect(page.items).toHaveLength(2);
	});

	test('merges the options of one collection over them', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
					uri: server.uri,
					collections,
					options: { maxPageSize: 2 },
					optionsFor: { users: { maxPageSize: 3 } },
				}),
			),
		);
		await mongo.db.users.createMany(threeUsers);
		expect((await mongo.db.users.paginate({ pageSize: 3 })).items).toHaveLength(
			3,
		);
		await mongo.db.posts.createMany([
			{ title: 'a' },
			{ title: 'b' },
			{ title: 'c' },
		]);
		expect((await mongo.db.posts.paginate({ pageSize: 3 })).items).toHaveLength(
			2,
		);
	});

	test('gives the default cursor scope to the collections, and to a derived Mongo', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
					uri: server.uri,
					collections,
					options: { cursorScope: 'tenant:a' },
					optionsFor: { posts: { cursorScope: 'tenant:b' } },
				}),
			),
		);
		await mongo.db.users.createMany(threeUsers);
		await mongo.db.posts.createMany([{ title: 'a' }, { title: 'b' }]);
		const users = await mongo.db.users.paginateByCursor({ limit: 1 });
		const posts = await mongo.db.posts.paginateByCursor({ limit: 1 });
		const same = (
			await mongo.db.users.paginateByCursor({
				limit: 1,
				scope: 'tenant:a',
			})
		).nextCursor;
		expect(same).toBe(users.nextCursor);
		// optionsFor outranks options: posts is bound to tenant:b.
		const viaB = (
			await mongo.db.posts.paginateByCursor({
				limit: 1,
				scope: 'tenant:b',
			})
		).nextCursor;
		expect(viaB).toBe(posts.nextCursor);
		// A derived Mongo keeps the scope.
		const derived = mongo.as(new ObjectId());
		expect(
			(await derived.db.users.paginateByCursor({ limit: 1 })).nextCursor,
		).toBe(users.nextCursor);
		const inSession = mongo.withSession(undefined);
		expect(
			(await inSession.db.users.paginateByCursor({ limit: 1 })).nextCursor,
		).toBe(users.nextCursor);
		await mongo.transaction(async (tx) => {
			expect(
				(await tx.db.users.paginateByCursor({ limit: 1 })).nextCursor,
			).toBe(users.nextCursor);
		});
	});

	test('syncs before the first operation when autoSync is on', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({ uri: server.uri, collections, autoSync: true }),
			),
		);
		await mongo.db.users.create({ email: 'ada@example.com' });
		// A write creates the collection by itself: the index is what says
		// the definition was applied.
		const indexes = await server.db.collection('users').indexes();
		expect(indexes.map((index) => index.name)).toContain('users_email_unique');
	});

	test('does not sync when autoSync is off', async () => {
		const mongo = await plainMongo();
		await mongo.db.users.create({ email: 'ada@example.com' });
		const indexes = await server.db.collection('users').indexes();
		expect(indexes.map((index) => index.name)).not.toContain(
			'users_email_unique',
		);
	});
});

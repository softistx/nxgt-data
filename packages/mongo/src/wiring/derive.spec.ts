import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { collections, events, useMongo } from '../../test/wiring';
import { WiringError } from '../errors/wiring-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-derive');

const plainMongo = async () =>
	track(await openMongo(defineMongo({ uri: server.uri, collections })));

describe('as', () => {
	test('stamps the actor on every collection of the Mongo', async () => {
		const mongo = await plainMongo();
		const actor = new ObjectId();
		const writer = mongo.as(actor);
		const user = await writer.db.users.create({ email: 'ada@example.com' });
		const post = await writer.db.posts.create({ title: 'a' });
		expect(user.createdBy).toEqual(actor);
		expect(post.createdBy).toEqual(actor);
		expect(writer.actor).toEqual(actor);
	});

	test('leaves the Mongo it came from alone', async () => {
		const mongo = await plainMongo();
		mongo.as(new ObjectId());
		const user = await mongo.db.users.create({ email: 'ada@example.com' });
		expect(user.createdBy).toBeNull();
		expect(mongo.actor).toBeUndefined();
	});

	test('shares the clients, and builds its own collections', async () => {
		const mongo = await plainMongo();
		const writer = mongo.as(new ObjectId());
		expect(writer.clients.default).toBe(mongo.clients.default);
		expect(writer.db.users).not.toBe(mongo.db.users);
		expect(writer.db.users).toBe(writer.db.users);
	});
});

describe('withSession', () => {
	test('carries the session, and gives it back', async () => {
		const mongo = await plainMongo();
		const session = mongo.clients.default.startSession();
		try {
			const inSession = mongo.withSession(session);
			expect(inSession.session).toBe(session);
			expect(mongo.session).toBeUndefined();
			await inSession.db.users.create({ email: 'ada@example.com' });
			expect(await mongo.db.users.count()).toBe(1);
		} finally {
			await session.endSession();
		}
	});

	test('takes the session away again', async () => {
		const mongo = await plainMongo();
		const session = mongo.clients.default.startSession();
		try {
			expect(
				mongo.withSession(session).withSession(undefined).session,
			).toBeUndefined();
		} finally {
			await session.endSession();
		}
	});

	test('keeps the actor the Mongo already had', async () => {
		const mongo = await plainMongo();
		const actor = new ObjectId();
		const derived = mongo.as(actor).withSession(undefined);
		expect(derived.actor).toEqual(actor);
	});
});

describe('the databases', () => {
	test('read one scope per name, built once', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'wiring-derive-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		expect(mongo.databases.main).toBe(mongo.databases.main);
		expect(mongo.databases.main.users).toBe(mongo.databases.main.users);
		expect(mongo.databases.analytics.events).not.toBe(
			mongo.databases.main.users,
		);
	});

	test('refuse `mongo.db` when there are several', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'wiring-derive-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		expect(() => mongo.db).toThrow('mongo.databases.main');
		try {
			void mongo.db;
		} catch (error) {
			expect(error).toBeInstanceOf(WiringError);
			expect(error).toHaveProperty('code', 'SEVERAL_DATABASES');
		}
	});
});

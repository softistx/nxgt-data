import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { collections, events, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-derive');

const plainKit = async () =>
	track(await createKit(defineConfig({ uri: server.uri, collections })));

describe('as', () => {
	test('stamps the actor on every collection of the kit', async () => {
		const kit = await plainKit();
		const actor = new ObjectId();
		const writer = kit.as(actor);
		const user = await writer.db.users.create({ email: 'ada@example.com' });
		const post = await writer.db.posts.create({ title: 'a' });
		expect(user.createdBy).toEqual(actor);
		expect(post.createdBy).toEqual(actor);
		expect(writer.actor).toEqual(actor);
	});

	test('leaves the kit it came from alone', async () => {
		const kit = await plainKit();
		kit.as(new ObjectId());
		const user = await kit.db.users.create({ email: 'ada@example.com' });
		expect(user.createdBy).toBeNull();
		expect(kit.actor).toBeUndefined();
	});

	test('shares the clients, and builds its own collections', async () => {
		const kit = await plainKit();
		const writer = kit.as(new ObjectId());
		expect(writer.clients.default).toBe(kit.clients.default);
		expect(writer.db.users).not.toBe(kit.db.users);
		expect(writer.db.users).toBe(writer.db.users);
	});
});

describe('withSession', () => {
	test('carries the session, and gives it back', async () => {
		const kit = await plainKit();
		const session = kit.clients.default.startSession();
		try {
			const inSession = kit.withSession(session);
			expect(inSession.session).toBe(session);
			expect(kit.session).toBeUndefined();
			await inSession.db.users.create({ email: 'ada@example.com' });
			expect(await kit.db.users.count()).toBe(1);
		} finally {
			await session.endSession();
		}
	});

	test('takes the session away again', async () => {
		const kit = await plainKit();
		const session = kit.clients.default.startSession();
		try {
			expect(
				kit.withSession(session).withSession(undefined).session,
			).toBeUndefined();
		} finally {
			await session.endSession();
		}
	});

	test('keeps the actor the kit already had', async () => {
		const kit = await plainKit();
		const actor = new ObjectId();
		const derived = kit.as(actor).withSession(undefined);
		expect(derived.actor).toEqual(actor);
	});
});

describe('the databases', () => {
	test('read one scope per name, built once', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'kit-derive-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		expect(kit.databases.main).toBe(kit.databases.main);
		expect(kit.databases.main.users).toBe(kit.databases.main.users);
		expect(kit.databases.analytics.events).not.toBe(kit.databases.main.users);
	});

	test('refuse `kit.db` when there are several', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'kit-derive-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		expect(() => kit.db).toThrow('kit.databases.main');
	});
});

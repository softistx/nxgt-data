import { describe, expect, test } from 'bun:test';
import { collections, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-scope');

/** A kit on the test server, closed after the file. */
const plainKit = async () =>
	track(await createKit(defineConfig({ uri: server.uri, collections })));

const threeUsers = [
	{ email: 'a@example.com' },
	{ email: 'b@example.com' },
	{ email: 'c@example.com' },
];

describe('the scope', () => {
	test('gives the same collection back at every read', async () => {
		const kit = await plainKit();
		expect(kit.db.users).toBe(kit.db.users);
	});

	test('builds each collection on its own', async () => {
		const kit = await plainKit();
		const users = kit.db.users;
		expect(kit.db.posts).not.toBe(users);
		expect(kit.db.users).toBe(users);
	});

	test('lists its collections, and not the driver`s members', async () => {
		const kit = await plainKit();
		expect(Object.keys(kit.db)).toEqual(['users', 'posts']);
	});

	test('answers `in` for its collections and for the driver`s members', async () => {
		const kit = await plainKit();
		expect('users' in kit.db).toBe(true);
		expect('command' in kit.db).toBe(true);
		expect('nothing' in kit.db).toBe(false);
	});

	test('binds the driver`s methods to the Db', async () => {
		const kit = await plainKit();
		const list = kit.db.listCollections.bind(kit.db);
		expect(await list().toArray()).toBeArray();
		const { command } = kit.db;
		expect(await command({ ping: 1 })).toMatchObject({ ok: 1 });
	});

	test('passes the options the config set for every collection', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					uri: server.uri,
					collections,
					options: { maxPageSize: 2 },
				}),
			),
		);
		await kit.db.users.createMany(threeUsers);
		const page = await kit.db.users.paginate({ pageSize: 3 });
		expect(page.items).toHaveLength(2);
	});

	test('merges the options of one collection over them', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					uri: server.uri,
					collections,
					options: { maxPageSize: 2 },
					optionsFor: { users: { maxPageSize: 3 } },
				}),
			),
		);
		await kit.db.users.createMany(threeUsers);
		expect((await kit.db.users.paginate({ pageSize: 3 })).items).toHaveLength(
			3,
		);
		await kit.db.posts.createMany([
			{ title: 'a' },
			{ title: 'b' },
			{ title: 'c' },
		]);
		expect((await kit.db.posts.paginate({ pageSize: 3 })).items).toHaveLength(
			2,
		);
	});

	test('syncs before the first operation when autoSync is on', async () => {
		const kit = track(
			await createKit(
				defineConfig({ uri: server.uri, collections, autoSync: true }),
			),
		);
		await kit.db.users.create({ email: 'ada@example.com' });
		// A write creates the collection by itself: the index is what says
		// the definition was applied.
		const indexes = await server.db.collection('users').indexes();
		expect(indexes.map((index) => index.name)).toContain('users_email_unique');
	});

	test('does not sync when autoSync is off', async () => {
		const kit = await plainKit();
		await kit.db.users.create({ email: 'ada@example.com' });
		const indexes = await server.db.collection('users').indexes();
		expect(indexes.map((index) => index.name)).not.toContain(
			'users_email_unique',
		);
	});
});

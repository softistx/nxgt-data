import { describe, expect, test } from 'bun:test';
import { collections, events, useMongo, users } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-create');

describe('createKit', () => {
	test('opens a client from the uri and wires the collections', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		const user = await kit.db.users.create({ email: 'ada@example.com' });
		expect(user.email).toBe('ada@example.com');
		expect(await kit.db.users.count()).toBe(1);
	});

	test('leaves the driver`s own Db reachable', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		const answer = await kit.db.command({ ping: 1 });
		expect(answer.ok).toBe(1);
		expect(kit.db.databaseName).toBe('kit-create');
	});

	test('uses the database the config names', async () => {
		const kit = track(
			await createKit(
				defineConfig({ uri: server.uri, database: 'other', collections }),
			),
		);
		expect(kit.db.databaseName).toBe('other');
	});

	test('holds every database of a multi-database config', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		expect(Object.keys(kit.databases)).toEqual(['main', 'analytics']);
		expect(kit.databases.analytics.databaseName).toBe('analytics');
		// One URI, one client: `connectMongo` shares it.
		expect(kit.clients.main).toBe(kit.clients.analytics);
		await kit.databases.main.users.create({ email: 'ada@example.com' });
		await kit.databases.analytics.events.create({ kind: 'signup' });
		expect(await kit.databases.main.users.count()).toBe(1);
	});

	test('refuses a key the driver`s Db already answers to', async () => {
		const config = defineConfig({
			uri: server.uri,
			collections: { command: users },
		} as never);
		await expect(createKit(config)).rejects.toThrow(
			'wires a collection under "command"',
		);
	});
});

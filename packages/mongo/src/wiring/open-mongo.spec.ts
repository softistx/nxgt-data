import { describe, expect, test } from 'bun:test';
import { collections, events, useMongo, users } from '../../test/wiring';
import { WiringError } from '../errors/wiring-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-create');

describe('openMongo', () => {
	test('opens a client from the uri and wires the collections', async () => {
		const mongo = track(
			await openMongo(defineMongo({ uri: server.uri, collections })),
		);
		const user = await mongo.db.users.create({ email: 'ada@example.com' });
		expect(user.email).toBe('ada@example.com');
		expect(await mongo.db.users.count()).toBe(1);
	});

	test('leaves the driver`s own Db reachable', async () => {
		const mongo = track(
			await openMongo(defineMongo({ uri: server.uri, collections })),
		);
		const answer = await mongo.db.command({ ping: 1 });
		expect(answer['ok']).toBe(1);
		expect(mongo.db.databaseName).toBe('wiring-create');
	});

	test('uses the database the config names', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({ uri: server.uri, database: 'other', collections }),
			),
		);
		expect(mongo.db.databaseName).toBe('other');
	});

	test('holds every database of a multi-database config', async () => {
		const mongo = track(
			await openMongo(
				defineMongo({
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
		expect(Object.keys(mongo.databases)).toEqual(['main', 'analytics']);
		expect(mongo.databases.analytics.databaseName).toBe('analytics');
		// One URI, one client: `connectMongo` shares it.
		expect(mongo.clients.main).toBe(mongo.clients.analytics);
		await mongo.databases.main.users.create({ email: 'ada@example.com' });
		await mongo.databases.analytics.events.create({ kind: 'signup' });
		expect(await mongo.databases.main.users.count()).toBe(1);
	});

	test('refuses a key the driver`s Db already answers to', async () => {
		const config = defineMongo({
			uri: server.uri,
			collections: { command: users },
		} as never);
		const error = await openMongo(config).then(null, (e: unknown) => e);
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'COLLISION');
		expect(error).toHaveProperty('key', 'command');
		expect(error).toHaveProperty(
			'message',
			expect.stringContaining('wires a collection under "command"'),
		);
	});
});

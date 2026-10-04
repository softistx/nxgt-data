import { describe, expect, test } from 'bun:test';
import { rejection, rejectionMessage } from '../../test/rejection';
import { collections, events, useMongo } from '../../test/wiring';
import { connectMongo } from '../connection/connect';
import { WiringError } from '../errors/wiring-error';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

/**
 * One Mongo at a time, each closed by its own test: `connectMongo` shares a
 * client per URI, so a Mongo another test left open would keep it alive and
 * every measurement here would read as a leak that is not one.
 */
const { server } = useMongo('wiring-close');

describe('close', () => {
	test('gives back the client it opened', async () => {
		const mongo = await openMongo(
			defineMongo({ uri: server.uri, collections }),
		);
		const client = mongo.clients.default;
		await mongo.close();
		await expect(
			await rejectionMessage(client.db().command({ ping: 1 })),
		).toContain('Client must be connected');
	});

	test('leaves a client the config gave it alone', async () => {
		const mongo = await openMongo(
			defineMongo({ client: server.client, collections }),
		);
		expect(mongo.clients.default).toBe(server.client);
		await mongo.close();
		const answer = await server.client.db().command({ ping: 1 });
		expect(answer['ok']).toBe(1);
	});

	test('runs once, however many callers ask', async () => {
		const mongo = await openMongo(
			defineMongo({ uri: server.uri, collections }),
		);
		await Promise.all([mongo.close(), mongo.close()]);
		await mongo.close();
		await expect(
			await rejection(mongo.clients.default.db().command({ ping: 1 })),
		).toBeInstanceOf(Error);
	});

	test('is what `await using` calls', async () => {
		let client: { db(): { command(c: object): Promise<unknown> } };
		{
			await using mongo = await openMongo(
				defineMongo({ uri: server.uri, collections }),
			);
			client = mongo.clients.default;
			await mongo.db.users.count();
		}
		await expect(
			await rejection(client.db().command({ ping: 1 })),
		).toBeInstanceOf(Error);
	});

	test('refuses a Mongo that came from `as` or `withSession`', async () => {
		const mongo = await openMongo(
			defineMongo({ uri: server.uri, collections }),
		);
		const derived = mongo.withSession(undefined);
		const error = await derived.close().then(null, (e: unknown) => e);
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'DERIVED');
		await mongo.close();
	});

	test('gives back what it opened when a later database refuses', async () => {
		const config = defineMongo({
			databases: {
				main: { uri: server.uri, collections },
				broken: { uri: server.uri, collections: { watch: events } },
			},
		} as never);
		await expect(await rejectionMessage(openMongo(config))).toContain(
			'wires a collection under "watch"',
		);
		// Nothing holds the shared client any more: this takes the only hold,
		// and giving it back closes the client for good.
		const connection = await connectMongo(server.uri);
		const { client } = connection;
		await connection.close();
		await expect(
			await rejection(client.db().command({ ping: 1 })),
		).toBeInstanceOf(Error);
	});
});

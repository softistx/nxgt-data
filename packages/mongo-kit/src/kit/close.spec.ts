import { describe, expect, test } from 'bun:test';
import { connectMongo } from '@nxgt/mongo';
import { collections, events, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { KitError } from '../errors/kit-error';
import { createKit } from './create-kit';

/**
 * One kit at a time, each closed by its own test: `connectMongo` shares a
 * client per URI, so a kit another test left open would keep it alive and
 * every measurement here would read as a leak that is not one.
 */
const { server } = useMongo('kit-close');

describe('close', () => {
	test('gives back the client it opened', async () => {
		const kit = await createKit(defineConfig({ uri: server.uri, collections }));
		const client = kit.clients.default;
		await kit.close();
		await expect(client.db().command({ ping: 1 })).rejects.toThrow(
			'Client must be connected',
		);
	});

	test('leaves a client the config gave it alone', async () => {
		const kit = await createKit(
			defineConfig({ client: server.client, collections }),
		);
		expect(kit.clients.default).toBe(server.client);
		await kit.close();
		const answer = await server.client.db().command({ ping: 1 });
		expect(answer.ok).toBe(1);
	});

	test('runs once, however many callers ask', async () => {
		const kit = await createKit(defineConfig({ uri: server.uri, collections }));
		await Promise.all([kit.close(), kit.close()]);
		await kit.close();
		await expect(
			kit.clients.default.db().command({ ping: 1 }),
		).rejects.toThrow();
	});

	test('is what `await using` calls', async () => {
		let client: { db(): { command(c: object): Promise<unknown> } };
		{
			await using kit = await createKit(
				defineConfig({ uri: server.uri, collections }),
			);
			client = kit.clients.default;
			await kit.db.users.count();
		}
		await expect(client.db().command({ ping: 1 })).rejects.toThrow();
	});

	test('refuses a kit that came from `as` or `withSession`', async () => {
		const kit = await createKit(defineConfig({ uri: server.uri, collections }));
		const derived = kit.withSession(undefined);
		const error = await derived.close().then(null, (e: unknown) => e);
		expect(error).toBeInstanceOf(KitError);
		expect(error).toHaveProperty('code', 'DERIVED');
		await kit.close();
	});

	test('gives back what it opened when a later database refuses', async () => {
		const config = defineConfig({
			databases: {
				main: { uri: server.uri, collections },
				broken: { uri: server.uri, collections: { watch: events } },
			},
		} as never);
		await expect(createKit(config)).rejects.toThrow(
			'wires a collection under "watch"',
		);
		// Nothing holds the shared client any more: this takes the only hold,
		// and giving it back closes the client for good.
		const connection = await connectMongo(server.uri);
		const { client } = connection;
		await connection.close();
		await expect(client.db().command({ ping: 1 })).rejects.toThrow();
	});
});

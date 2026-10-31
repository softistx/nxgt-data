// A probe, not part of `bun test src`: run it by path.
// An autoSync tenant database first touched inside a transaction that already
// wrote to `main`, with retryTransient: false. Does the sync (createIndex on
// a collection that does not exist yet) fail inside the session's transaction?
import { expect, test } from 'bun:test';
import { MongoClient } from 'mongodb';
import { resetAutoSync } from '../../src/collection/auto-sync';
import { defineMongo } from '../../src/wiring/config/define-mongo';
import { openMongo } from '../../src/wiring/open-mongo';
import { collections, useMongo } from '../wiring';

const { server, track } = useMongo('probe-autosync-tx');

test('autoSync tenant database first touched in a transaction', async () => {
	const client = await MongoClient.connect(server.uri);
	await client.db('tenant_probe').dropDatabase();
	await client.close();
	resetAutoSync();
	const mongo = track(
		await openMongo(
			defineMongo({ uri: server.uri, collections, autoSync: true }),
		),
	);
	await mongo.transaction(
		async (tx) => {
			await tx.db.users.create({ email: 'main@example.com' });
			const tenant = tx.database('tenant_probe');
			await tenant.db.users.create({ email: 'tenant@example.com' });
		},
		{ retryTransient: false },
	);
	expect(await mongo.database('tenant_probe').db.users.count()).toBe(1);
});

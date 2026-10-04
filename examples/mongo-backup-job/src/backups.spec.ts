import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyFile } from '@nxgt/mongo-backup';
import { startMongo } from '../test/mongo';
import { shopBackups } from './backups';

let server: Awaited<ReturnType<typeof startMongo>>;
let folder: string;
beforeAll(async () => {
	server = await startMongo();
	folder = await mkdtemp(join(tmpdir(), 'mongo-backup-job-'));
});
afterAll(async () => {
	await server.stop();
	await rm(folder, { recursive: true, force: true });
});

test('names what the environment misses, and quotes no value', () => {
	expect(() => shopBackups(server.client, { MONGO_DB: 'shop' })).toThrow(
		'mongo-backup-job: set BACKUP_PATH, BACKUP_KEY_FILE',
	);
});

test('backs up hourly, chains, and a drill restores what the database holds', async () => {
	const keyFile = join(folder, 'backup.key');
	await generateKeyFile(keyFile);
	const backups = shopBackups(server.client, {
		MONGO_DB: 'shop',
		BACKUP_PATH: join(folder, 'repo'),
		BACKUP_KEY_FILE: keyFile,
	});
	const orders = server.client.db('shop').collection('orders');
	await orders.insertMany([{ n: 1 }, { n: 2 }]);
	expect(await backups.run()).toMatchObject({ kind: 'full', chain: 1 });
	await orders.insertOne({ n: 3 });
	const second = await backups.run();
	expect(second).toMatchObject({ kind: 'incremental', chain: 2 });
	expect(await backups.drill()).toEqual({
		id: second.id,
		collections: [{ name: 'orders', documents: 3 }],
	});
});

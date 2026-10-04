import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BackupInfo, generateSigningKeys } from '@nxgt/backup';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { startMongo } from '../test/mongo';
import { configFromEnv } from './config';
import { backupJob, jobOf, restoreDrill } from './job';
import { FULL_EVERY, kindFor } from './plan';

let server: Awaited<ReturnType<typeof startMongo>>;
let folder: string;
let env: Record<string, string>;

beforeAll(async () => {
	server = await startMongo();
	folder = await mkdtemp(join(tmpdir(), 'mongo-backup-job-'));
	const identity = await generateIdentity();
	await writeFile(join(folder, 'identity'), `${identity}\n`, { mode: 0o600 });
	await writeFile(
		join(folder, 'signing.pem'),
		generateSigningKeys().privateKey,
		{
			mode: 0o600,
		},
	);
	env = {
		MONGO_URL: server.uri,
		MONGO_DB: 'shop',
		BACKUP_PATH: join(folder, 'repo'),
		BACKUP_RECIPIENT: await identityToRecipient(identity),
		BACKUP_IDENTITY_FILE: join(folder, 'identity'),
		BACKUP_SIGNING_KEY_FILE: join(folder, 'signing.pem'),
	};
});
afterAll(async () => {
	await server.stop();
	await rm(folder, { recursive: true, force: true });
});

describe('configFromEnv', () => {
	test('names what is missing, and quotes no value', async () => {
		const { MONGO_URL: _url, BACKUP_IDENTITY_FILE: _file, ...rest } = env;
		// Held with `.then`, not `expect().rejects`: see AGENTS.md on Bun.
		const error = await configFromEnv(rest).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toHaveProperty(
			'message',
			'mongo-backup-job: set MONGO_URL, BACKUP_IDENTITY_FILE',
		);
		const config = await configFromEnv(env);
		expect(config.identity.startsWith('AGE-SECRET-KEY-')).toBe(true);
	});
});

describe('kindFor', () => {
	const now = new Date('2026-10-04T12:00:00Z');
	const full = (age: number): BackupInfo =>
		({ kind: 'full', createdAt: new Date(now.getTime() - age) }) as BackupInfo;
	test('a full backup first, then incrementals until it is a week old', () => {
		expect(kindFor([], now)).toBe('full');
		expect(kindFor([full(FULL_EVERY - 1)], now)).toBe('incremental');
		expect(kindFor([full(FULL_EVERY)], now)).toBe('full');
	});
});

describe('the job', () => {
	test('backs up, chains, rotates, and a drill restores what the database holds', async () => {
		const config = await configFromEnv(env);
		const db = server.client.db('shop');
		const job = jobOf(config, db);
		await db.collection('orders').insertMany([{ n: 1 }, { n: 2 }]);
		await db.createCollection('open', { viewOn: 'orders', pipeline: [] });

		const first = await backupJob(job);
		expect(first).toMatchObject({ kind: 'full', chain: 1, removed: [] });
		await db.collection('orders').insertOne({ n: 3 });
		await db.collection('customers').insertOne({ name: 'a' });
		const second = await backupJob(job);
		expect(second).toMatchObject({ kind: 'incremental', chain: 2 });

		const drill = await restoreDrill(job);
		expect(drill).toEqual({
			id: second.id,
			collections: [
				{ name: 'customers', documents: 1 },
				{ name: 'orders', documents: 3 },
			],
		});
		const { databases } = await server.client
			.db('admin')
			.admin()
			.listDatabases();
		expect(databases.some((d) => /^(drill|nxgt-restore)-/.test(d.name))).toBe(
			false,
		);

		// The oplog no longer reaching the last backup: a full one instead.
		await server.failNext('aggregate', 286);
		expect(await backupJob(job)).toMatchObject({ kind: 'full', chain: 1 });

		// A week on, a new chain starts.
		const later = new Date(Date.now() + FULL_EVERY);
		expect(await backupJob(job, later)).toMatchObject({
			kind: 'full',
			chain: 1,
		});
	});
});

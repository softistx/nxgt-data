import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { BackupSource, Since } from '@nxgt/backup';
import { BSON, type Db } from 'mongodb';
import { contents, type Harness, harness } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { MongoBackupError } from './errors';
import { writePosition } from './format/position';
import { mongoSource } from './source/mongo-source';
import { mongoTarget } from './target/mongo-target';

let server: TestServer;
let h: Harness;

beforeAll(async () => {
	server = await startMongo();
});
afterAll(() => server.stop());
beforeEach(async () => {
	await server.reset();
	await server.client.db('restored').dropDatabase();
	h = await harness();
});
afterEach(async () => {
	await server.clearFailures();
	await h.remove();
});

const restored = () => server.client.db('restored');

const incremental = (source: BackupSource) =>
	h.backups.create(source, { kind: 'incremental', identities: [h.identity] });

/** Every entry of an incremental built on `since`, each read to its end. */
async function readAll(db: Db, since: Since): Promise<void> {
	for await (const entry of mongoSource({ db }).entries(since)) {
		if (entry.name.startsWith('changes/'))
			await new Response(await entry.open()).bytes();
	}
}

function expectCode(error: unknown, code: string, message: string): void {
	expect(error).toBeInstanceOf(MongoBackupError);
	expect(error).toHaveProperty('code', code);
	expect(error).toHaveProperty('message', message);
}

describe('an incremental backup refuses', () => {
	test('a position the oplog no longer reaches', async () => {
		const since: Since = {
			id: 'x',
			position: writePosition({
				resume: { startAtOperationTime: new BSON.Timestamp({ t: 1, i: 1 }) },
				added: [],
				removed: [],
			}),
			entries: new Map(),
		};
		// An oplog never truncated holds its whole history: the server is
		// made to answer as one that lost it does.
		await server.failNext(['aggregate'], { errorCode: 286 });
		expectCode(
			await rejection(readAll(server.db, since)),
			'HISTORY_LOST',
			'mongoSource: the change stream cannot resume where the last backup ' +
				'stopped: the oplog no longer reaches back there; make a full backup',
		);
	});

	test('a backup built on that recorded no position', async () => {
		for (const position of [undefined, '{}', 'not json']) {
			expectCode(
				await rejection(
					readAll(server.db, { id: 'x', position, entries: new Map() }),
				),
				'MALFORMED',
				'mongoSource: the backup built on recorded no position this version ' +
					'reads; make a full backup',
			);
		}
	});

	test('an update to a dotted field, unless the collection keeps post-images', async () => {
		const { db } = server;
		// Enough else in it that the server records a delta, not a replace.
		const rest = { k: 'k'.repeat(200) };
		await db.collection('a').insertOne({ _id: 1 as never, ...rest, 'x.y': 1 });
		await db.createCollection('b', {
			changeStreamPreAndPostImages: { enabled: true },
		});
		await db.collection('b').insertOne({ _id: 1 as never, ...rest, 'x.y': 1 });
		const source = mongoSource({ db, collections: ['b'] });
		await h.backups.create(source);
		const dotted = [
			{
				$replaceWith: {
					$setField: { field: 'x.y', input: '$$ROOT', value: 5 },
				},
			},
		];
		await db.collection('b').updateOne({ _id: 1 as never }, dotted);
		const kept = await incremental(source);
		await h.backups.restore(kept.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(await contents(restored())).toEqual({
			b: (await contents(db))['b'] as string,
		});

		const all = mongoSource({ db });
		await h.backups.create(all);
		await db.collection('a').updateOne({ _id: 1 as never }, dotted);
		expectCode(
			await rejection(incremental(all)),
			'UNSUPPORTED',
			'mongoSource: an update touched a field whose name holds a dot or is a ' +
				'number, which a change cannot say without its post-image; turn on ' +
				'changeStreamPreAndPostImages for that collection, or make a full backup',
		);
	});

	test('a time-series collection, in a full backup or created since', async () => {
		const { db } = server;
		const message =
			'mongoSource: a collection is of a type this version does not back up ' +
			'(a time-series one); leave it out with collections';
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.createCollection('series', { timeseries: { timeField: 't' } });
		expectCode(await rejection(incremental(source)), 'UNSUPPORTED', message);
		expectCode(
			await rejection(h.backups.create(mongoSource({ db }))),
			'UNSUPPORTED',
			message,
		);
		const without = mongoSource({
			db,
			collections: (n) => !n.startsWith('series'),
		});
		await h.backups.create(without);
		// One left out is skipped before its events are read: no refusal.
		await db.createCollection('series-2', { timeseries: { timeField: 't' } });
		await incremental(without);
	});
});

describe('a full backup refuses', () => {
	test('a snapshot older than the server keeps', async () => {
		await server.db.collection('a').insertOne({ n: 1 });
		await server.failNext(['find'], { errorCode: 239 });
		expectCode(
			await rejection(h.backups.create(mongoSource({ db: server.db }))),
			'SNAPSHOT_TOO_OLD',
			'mongoSource: the snapshot outlived the history the server keeps; ' +
				'raise minSnapshotHistoryWindowInSeconds, or back up fewer ' +
				'collections at a time',
		);
	});
});

describe('a dropped database', () => {
	test('is recorded, restored as dropped, and the next backup resumes after it', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		const source = mongoSource({ db });
		await h.backups.create(source);
		await db.dropDatabase();
		const dropped = await incremental(source);
		await h.backups.restore(dropped.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(await contents(restored())).toEqual({});
		await db.collection('b').insertOne({ n: 2 });
		const next = await incremental(source);
		await restored().dropDatabase();
		await h.backups.restore(next.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(await contents(restored())).toEqual(await contents(db));
	});
});

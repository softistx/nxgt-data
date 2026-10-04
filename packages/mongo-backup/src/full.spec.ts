import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { BackupSource } from '@nxgt/backup';
import { BSON, type CollectionInfo, GridFSBucket } from 'mongodb';
import { contents, type Harness, harness, indexesOf } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { MongoBackupError } from './errors';
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
afterEach(() => h.remove());

const restored = () => server.client.db('restored');

async function fill(): Promise<void> {
	const { db } = server;
	await db.createCollection('people', {
		validator: { $jsonSchema: { required: ['name'] } },
		collation: { locale: 'fr', strength: 2 },
	});
	await db.collection('people').insertMany([
		{
			_id: new BSON.ObjectId(),
			name: 'a',
			age: new BSON.Int32(3),
			big: BSON.Long.fromString('9007199254740993'),
			price: BSON.Decimal128.fromString('1.10'),
			ratio: new BSON.Double(2),
			born: new Date('2020-01-02T03:04:05.006Z'),
			bytes: new BSON.Binary(new Uint8Array([1, 2, 3]), 4),
			tags: ['x', { deep: [1, 2] }],
		},
		{ name: 'b', nothing: null, pattern: new BSON.BSONRegExp('^a', 'i') },
	]);
	// Written past the validator, and restored as it was.
	await db
		.collection('people')
		.insertOne({ invalid: true }, { bypassDocumentValidation: true });
	await db.collection('people').createIndexes([
		{ key: { name: 1 }, name: 'by_name', unique: true },
		{ key: { born: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
		{
			key: { age: -1 },
			name: 'partial',
			partialFilterExpression: { age: { $gt: 1 } },
		},
	]);
	await db.createCollection('log', { capped: true, size: 4096 });
	await db.collection('log').insertOne({ at: 1 });
	await db.createCollection('adults', {
		viewOn: 'people',
		pipeline: [{ $match: { age: { $gte: 18 } } }],
	});
	const bucket = new GridFSBucket(db, { bucketName: 'files' });
	const upload = bucket.openUploadStream('photo.bin');
	upload.end(Buffer.alloc(600_000, 7));
	await new Promise((resolve, reject) => {
		upload.once('finish', resolve);
		upload.once('error', reject);
	});
}

describe('a full backup', () => {
	test('restores every collection, number kinds, indexes, options, views and GridFS', async () => {
		await fill();
		const created = await h.backups.create(mongoSource({ db: server.db }));
		expect(created.kind).toBe('full');
		await h.backups.restore(created.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(await contents(restored())).toEqual(await contents(server.db));
		expect(await indexesOf(restored(), 'people')).toEqual(
			await indexesOf(server.db, 'people'),
		);
		const info = async (name: string) =>
			(await restored().listCollections({ name }).toArray())[0] as
				| CollectionInfo
				| undefined;
		expect((await info('people'))?.options).toMatchObject({
			validator: { $jsonSchema: { required: ['name'] } },
			collation: { locale: 'fr', strength: 2 },
		});
		expect((await info('log'))?.options).toMatchObject({ capped: true });
		expect(await info('adults')).toMatchObject({
			type: 'view',
			options: { viewOn: 'people' },
		});
		const bucket = new GridFSBucket(restored(), { bucketName: 'files' });
		const chunks: Buffer[] = [];
		for await (const chunk of bucket.openDownloadStreamByName('photo.bin')) {
			chunks.push(chunk as Buffer);
		}
		expect(Buffer.concat(chunks).equals(Buffer.alloc(600_000, 7))).toBe(true);
	});

	test('reads every collection at one cluster time', async () => {
		const { db } = server;
		await db.collection('a').insertOne({ n: 1 });
		await db.collection('b').insertOne({ n: 1 });
		const source = mongoSource({ db });
		let written = false;
		const writing: BackupSource = {
			kind: source.kind,
			async *entries() {
				for await (const entry of source.entries()) {
					// Written once the snapshot is open, before any entry is read.
					if (!written) {
						written = true;
						await db.collection('b').insertOne({ n: 2 });
					}
					yield entry;
				}
			},
			position: () => source.position?.(),
		};
		const created = await h.backups.create(writing);
		await h.backups.restore(created.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(await restored().collection('b').countDocuments()).toBe(1);
	});

	test('takes only the collections asked for, and refuses a name not there', async () => {
		await server.db.collection('a').insertOne({ n: 1 });
		await server.db.collection('b').insertOne({ n: 1 });
		const created = await h.backups.create(
			mongoSource({ db: server.db, collections: ['b'] }),
		);
		await h.backups.restore(created.id, mongoTarget({ db: restored() }), {
			identities: [h.identity],
		});
		expect(Object.keys(await contents(restored()))).toEqual(['b']);
		const error = await rejection(
			h.backups.create(mongoSource({ db: server.db, collections: ['c'] })),
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(error).toHaveProperty(
			'message',
			'mongoSource: a collection named in collections is not in the database',
		);
	});
});

describe('a restore', () => {
	test('refuses a collection already there, and touches nothing of it', async () => {
		await server.db.collection('a').insertOne({ n: 1 });
		const created = await h.backups.create(mongoSource({ db: server.db }));
		await restored().collection('a').insertOne({ mine: true });
		const view = mongoSource({ db: server.db });
		await server.db.createCollection('v', { viewOn: 'a', pipeline: [] });
		const withView = await h.backups.create(view);
		await restored().createCollection('v', {
			viewOn: 'elsewhere',
			pipeline: [],
		});
		const viewError = await rejection(
			h.backups.restore(withView.id, mongoTarget({ db: restored() }), {
				identities: [h.identity],
				only: ['metadata/v'],
			}),
		);
		expect(viewError).toHaveProperty('code', 'EXISTS');
		await server.db.dropCollection('v');
		await restored().dropCollection('v');
		const error = await rejection(
			h.backups.restore(created.id, mongoTarget({ db: restored() }), {
				identities: [h.identity],
			}),
		);
		expect(error).toBeInstanceOf(MongoBackupError);
		expect(error).toHaveProperty('code', 'EXISTS');
		const mine = await restored()
			.collection('a')
			.find({}, { projection: { _id: 0 } })
			.toArray();
		expect(mine as unknown[]).toEqual([{ mine: true }]);
		await h.backups.restore(
			created.id,
			mongoTarget({ db: restored(), replace: true }),
			{ identities: [h.identity] },
		);
		expect(await contents(restored())).toEqual(await contents(server.db));
	});

	test('a damaged collection lands nothing, and leaves no staging behind', async () => {
		await server.db.collection('a').insertMany([{ n: 1 }, { n: 2 }]);
		const created = await h.backups.create(mongoSource({ db: server.db }));
		const target = mongoTarget({ db: restored() });
		const failing = {
			write: async (name: string, stream: ReadableStream<Uint8Array>) => {
				if (!name.startsWith('documents/')) return target.write(name, stream);
				const reader = stream.getReader();
				const broken = new ReadableStream<Uint8Array>({
					async pull(controller) {
						const { done, value } = await reader.read();
						if (done) controller.error(new Error('damaged at its end'));
						else controller.enqueue(value);
					},
				});
				await target
					.write(name, broken)
					.finally(() => reader.cancel().catch(() => undefined));
			},
		};
		await rejection(
			h.backups.restore(created.id, failing, { identities: [h.identity] }),
		);
		expect(
			await restored().listCollections({}, { nameOnly: true }).toArray(),
		).toEqual([]);
	});
});

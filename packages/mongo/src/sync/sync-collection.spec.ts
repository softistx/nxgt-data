import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { z } from 'zod';
import { rejection, rejectionMessage } from '../../test/rejection';
import { logs, posts, users } from '../../test/schema';
import { startMongo, type TestServer } from '../../test/server';
import { defineCollection } from '../definition/define-collection';
import { id } from '../definition/fields';
import { syncCollection, syncCollections } from './sync-collection';

let t: TestServer;

beforeAll(async () => {
	t = await startMongo();
}, 120_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** The collection's options, as `listCollections` reports them. */
const optionsOf = async (name: string) => {
	const [info] = await t.db
		.listCollections({ name }, { nameOnly: false })
		.toArray();
	return (info?.options ?? undefined) as Record<string, unknown> | undefined;
};

const indexNames = async (name: string) =>
	(await t.db.collection(name).indexes()).map((index) => index.name).sort();

describe('syncCollection', () => {
	test('creates the collection, its validator and its indexes', async () => {
		const report = await syncCollection(t.db, users);
		expect(report).toMatchObject({
			name: 'users',
			created: true,
			validator: 'created',
			dryRun: false,
		});
		expect(report.indexes.created.sort()).toEqual([
			'users_createdAt',
			'users_email_unique',
		]);

		const options = await optionsOf('users');
		expect(options?.validationLevel).toBe('strict');
		expect(options?.validationAction).toBe('error');
		const validator = options?.validator as
			| { $jsonSchema: { properties: object } }
			| undefined;
		expect(validator?.$jsonSchema.properties).toMatchObject({
			_id: { bsonType: 'objectId' },
		});
		expect(await indexNames('users')).toEqual([
			'_id_',
			'users_createdAt',
			'users_email_unique',
		]);
	});

	test('a second run in a row changes nothing', async () => {
		await syncCollection(t.db, users);
		const report = await syncCollection(t.db, users);
		expect(report).toEqual({
			name: 'users',
			created: false,
			validator: 'unchanged',
			options: { changed: [], immutable: [] },
			indexes: {
				created: [],
				recreated: [],
				dropped: [],
				unchanged: ['users_email_unique', 'users_createdAt'],
			},
			dryRun: false,
		});
	});

	test('a dry run reports everything and sends nothing', async () => {
		const report = await syncCollection(t.db, users, { dryRun: true });
		expect(report.created).toBe(true);
		expect(report.validator).toBe('created');
		expect(report.indexes.created.sort()).toEqual([
			'users_createdAt',
			'users_email_unique',
		]);
		expect(report.dryRun).toBe(true);
		expect(await optionsOf('users')).toBeUndefined();
	});

	test('writes a validator that changed, and keeps the collection', async () => {
		await syncCollection(t.db, users);
		const narrowed = defineCollection({
			name: 'users',
			schema: z.object({ _id: id(), email: z.string() }),
			indexes: users.indexes,
			validation: { level: 'moderate', action: 'warn' },
		});

		const report = await syncCollection(t.db, narrowed);
		expect(report.created).toBe(false);
		expect(report.validator).toBe('updated');
		const options = await optionsOf('users');
		expect(options?.validationLevel).toBe('moderate');
		expect(options?.validationAction).toBe('warn');
		const validator = options?.validator as
			| { $jsonSchema: { required: string[] } }
			| undefined;
		expect(validator?.$jsonSchema.required).toEqual(['_id', 'email']);
	});

	test('rebuilds an index whose options changed, since MongoDB cannot alter one', async () => {
		await syncCollection(t.db, posts);
		const changed = defineCollection({
			name: 'posts',
			schema: posts.schema,
			indexes: [{ key: { rank: -1 }, name: 'posts_rank_title' }],
		});

		const report = await syncCollection(t.db, changed);
		expect(report.indexes).toMatchObject({
			created: [],
			recreated: ['posts_rank_title'],
			dropped: [],
			unchanged: [],
		});
		const live = await t.db.collection('posts').indexes();
		expect(
			live.find((index) => index.name === 'posts_rank_title')?.key,
		).toEqual({ rank: -1 });
	});

	test('leaves an index no definition names alone, unless asked', async () => {
		await syncCollection(t.db, posts);
		await t.db
			.collection('posts')
			.createIndex({ title: 1 }, { name: 'by_hand' });

		const kept = await syncCollection(t.db, posts);
		expect(kept.indexes.dropped).toEqual([]);
		expect(await indexNames('posts')).toContain('by_hand');

		const dropped = await syncCollection(t.db, posts, {
			dropUnknownIndexes: true,
		});
		expect(dropped.indexes.dropped).toEqual(['by_hand']);
		// `_id_` is never dropped: MongoDB refuses to.
		expect(await indexNames('posts')).toEqual(['_id_', 'posts_rank_title']);
	});

	test('level off writes no validator, and removes one that is there', async () => {
		const report = await syncCollection(t.db, logs);
		expect(report.created).toBe(true);
		expect(report.validator).toBe('unchanged');
		expect(await optionsOf('logs')).toEqual({});
		// Nothing checks the documents: this one has no schema at all.
		await t.db.collection('logs').insertOne({ whatever: true });

		const validated = defineCollection({
			name: 'logs',
			schema: logs.schema,
		});
		expect((await syncCollection(t.db, validated)).validator).toBe('created');
		const off = await syncCollection(t.db, logs);
		expect(off.validator).toBe('removed');
		// Removing it leaves no `validator` key at all, and the level behind.
		expect((await optionsOf('logs'))?.validator).toBeUndefined();
		expect((await syncCollection(t.db, logs)).validator).toBe('unchanged');
	});

	test('the validator it writes is the one that refuses a bad document', async () => {
		await syncCollection(t.db, users);
		const bad = rejection(
			t.db.collection('users').insertOne({ email: 'not-an-email' } as never),
		);
		expect(await bad).toMatchObject({ code: 121 });
	});
});

describe('the collection options', () => {
	const capped = defineCollection({
		name: 'audit',
		schema: z.object({ _id: id(), message: z.string() }),
		options: { capped: { size: 4096, max: 10 } },
	});

	const readings = defineCollection({
		name: 'readings',
		schema: z.object({ _id: id(), at: z.date(), sensor: z.string() }),
		options: {
			timeseries: { timeField: 'at', metaField: 'sensor' },
			expireAfterSeconds: 3600,
		},
	});

	test('creates the collection with them', async () => {
		const report = await syncCollection(t.db, capped);
		expect(report.created).toBe(true);
		expect(report.options).toEqual({ changed: [], immutable: [] });
		expect(await optionsOf('audit')).toMatchObject({
			capped: true,
			size: 4096,
			max: 10,
		});
	});

	test('a second run changes nothing, defaults and all', async () => {
		// The server fills a collation in and computes a bucket span: a sync
		// that compared for equality would report a difference every time.
		await syncCollection(t.db, readings);
		const again = await syncCollection(t.db, readings);
		expect(again.options).toEqual({ changed: [], immutable: [] });
		expect(again.created).toBe(false);
	});

	test('changes what collMod accepts', async () => {
		await syncCollection(t.db, capped);
		const wider = defineCollection({
			name: 'audit',
			schema: capped.schema,
			options: { capped: { size: 8192, max: 10 } },
		});
		const report = await syncCollection(t.db, wider);
		expect(report.options.changed).toEqual(['capped.size']);
		expect(await optionsOf('audit')).toMatchObject({ size: 8192 });
		// And once it is done, it is done.
		expect((await syncCollection(t.db, wider)).options.changed).toEqual([]);
	});

	test('throws on a difference MongoDB cannot change, naming it', async () => {
		// A plain collection is there; the definition now asks for a capped one.
		await syncCollection(t.db, logs);
		const cappedLogs = defineCollection({
			name: 'logs',
			schema: logs.schema,
			options: { capped: { size: 4096 } },
		});
		const message = await rejectionMessage(syncCollection(t.db, cappedLogs));
		expect(message).toContain('"logs" already exists');
		expect(message).toContain('capped: the collection has null');
		// And it sent nothing: the collection is what it was.
		expect((await optionsOf('logs'))?.capped).toBeUndefined();
	});

	test('a dry run lists them all instead of throwing on the first', async () => {
		await syncCollection(t.db, logs);
		const other = defineCollection({
			name: 'logs',
			schema: logs.schema,
			options: {
				capped: { size: 4096 },
				collation: { locale: 'fr' },
			},
		});
		const report = await syncCollection(t.db, other, { dryRun: true });
		expect(report.options.immutable.map((m) => m.option)).toEqual([
			'capped',
			'collation',
		]);
		expect((await optionsOf('logs'))?.capped).toBeUndefined();
	});
});

describe('syncCollections', () => {
	test('syncs each definition in order, and reports each', async () => {
		const reports = await syncCollections(t.db, [users, posts, logs]);
		expect(reports.map((report) => [report.name, report.created])).toEqual([
			['users', true],
			['posts', true],
			['logs', true],
		]);

		const again = await syncCollections(t.db, [users, posts, logs]);
		expect(again.every((report) => report.validator === 'unchanged')).toBe(
			true,
		);
		expect(again.flatMap((report) => report.indexes.created)).toEqual([]);
	});
});

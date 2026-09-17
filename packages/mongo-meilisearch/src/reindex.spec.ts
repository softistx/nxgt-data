import { describe, expect, test } from 'bun:test';
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { defineCollection, getCollection } from '@nxgt/mongo';
import { z } from 'zod';
import { byId, useServers } from '../test/fixtures';
import { createSearchSync } from './create-search-sync';
import { SearchSyncError } from './errors';

const { servers, collection, index, sync, indexed } = useServers('reindex');

describe('reindex', () => {
	test('sends every live document through the transform', async () => {
		const [a, b] = await collection().createMany([
			{ title: 'Alpha' },
			{ title: 'Beta' },
			{ title: 'Draft', draft: true },
		]);
		const gone = await collection().create({ title: 'Gone' });
		await collection().delete(gone._id);

		const report = await sync().reindex();

		expect(report).toEqual({ indexed: 2, skipped: 1, removed: 0 });
		expect(await indexed()).toEqual(
			byId([
				[String(a?._id), 'Alpha'],
				[String(b?._id), 'Beta'],
			]),
		);
	});

	test('pages through the collection and batches the writes', async () => {
		await collection().createMany(
			Array.from({ length: 23 }, (_, i) => ({ title: `t${i}` })),
		);
		const report = await sync({ pageSize: 5, batchSize: 4 }).reindex();
		expect(report.indexed).toBe(23);
		expect((await indexed()).length).toBe(23);
	});

	test('takes out what the index holds and should not', async () => {
		const kept = await collection().create({ title: 'Kept' });
		const drafted = await collection().create({ title: 'Later a draft' });
		await index().add(
			[
				{ id: 'stale', title: 'Not in the collection' },
				{ id: String(drafted._id), title: 'Later a draft' },
			],
			{ wait: true },
		);
		await collection().update(drafted._id, { draft: true });

		const report = await sync().reindex();

		expect(report).toEqual({ indexed: 1, skipped: 1, removed: 2 });
		expect(await indexed()).toEqual([[String(kept._id), 'Kept']]);
	});

	test('pages through an index larger than one listing', async () => {
		await index().addInBatches(
			Array.from({ length: 1005 }, (_, i) => ({ id: `s${i}`, title: 'x' })),
			{ wait: true },
		);
		const report = await sync().reindex();
		expect(report.removed).toBe(1005);
		expect(await indexed()).toEqual([]);
	});

	test('records where following resumes, and when it ran', async () => {
		const search = sync();
		expect(await search.state()).toBeUndefined();
		const before = Date.now();
		await search.reindex();
		const state = await search.state();
		expect(state?._id).toBe('articles:articles');
		expect(state?.resumeToken).toBeDefined();
		expect(state?.reindexedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(state?.updatedAt).toEqual(state?.reindexedAt as Date);

		const again = await search.state();
		await search.reindex();
		expect((await search.state())?.reindexedAt?.getTime()).toBeGreaterThan(
			again?.reindexedAt?.getTime() ?? 0,
		);
	});

	test('keeps its state under its name, in its collection', async () => {
		await sync({ name: 'mine', stateCollection: 'search_state' }).reindex();
		const saved = await servers.mongo.db
			.collection<{ _id: string }>('search_state')
			.findOne({ _id: 'mine' });
		expect(saved?._id).toBe('mine');
		expect(await sync().state()).toBeUndefined();
	});

	test('a transform that throws fails the reindex, with the cause', async () => {
		await collection().create({ title: 'a' });
		const boom = new Error('boom');
		const error = await sync({
			name: 'broken',
			transform: () => {
				throw boom;
			},
		})
			.reindex()
			.catch((caught: unknown) => caught);
		if (!(error instanceof SearchSyncError)) throw error;
		expect(error.code).toBe('FAILED');
		expect(error.sync).toBe('broken');
		expect(error.message).toBe('Search sync "broken" failed reindexing: boom');
		expect(error.cause).toBe(boom);
		expect(await sync({ name: 'broken' }).state()).toBeUndefined();
	});

	test('a document under another id is refused', async () => {
		const article = await collection().create({ title: 'a' });
		const error = await sync({
			transform: (doc) => ({ id: 'other', title: doc.title }),
		})
			.reindex()
			.catch((caught: unknown) => caught);
		if (!(error instanceof SearchSyncError)) throw error;
		expect(error.code).toBe('ID_MISMATCH');
		expect(error.message).toContain(
			`transform gave "id" "other" for the document ${String(article._id)}`,
		);
		expect(await indexed()).toEqual([]);
	});

	test('a transform that gives no document is refused', async () => {
		await collection().create({ title: 'a' });
		const error = await sync({
			// @ts-expect-error a transform gives a document or null
			transform: () => 'nope',
		})
			.reindex()
			.catch((caught: unknown) => caught);
		if (!(error instanceof SearchSyncError)) throw error;
		expect(error.message).toContain(
			'transform must return a document or null, not nope',
		);
		const listed = await sync({
			// @ts-expect-error an array is not a document
			transform: () => [],
		})
			.reindex()
			.catch((caught: unknown) => caught);
		if (!(listed instanceof SearchSyncError)) throw listed;
		expect(listed.message).toContain('transform must return a document');
	});

	test('a server error is wrapped, and nothing is recorded', async () => {
		await collection().create({ title: 'a' });
		await servers.mongo.failNext(['find'], { errorCode: 13 });
		const error = await sync()
			.reindex()
			.catch((caught: unknown) => caught);
		if (!(error instanceof SearchSyncError)) throw error;
		expect(error.code).toBe('FAILED');
		expect(await sync().state()).toBeUndefined();
	});
});

const counters = defineCollection({
	name: 'counters',
	schema: z.object({ _id: z.int(), label: z.string() }),
});
const counterIndex = defineIndex<{ n: number; label: string }>()({
	uid: 'counters',
	primaryKey: 'n',
	settings: {},
});

test('ids that are not strings go through toIndexId', async () => {
	const collection = getCollection(servers.mongo.db, counters);
	await collection.createMany([
		{ _id: 1, label: 'one' },
		{ _id: 2, label: 'two' },
	]);
	const index = bindIndex(servers.meili.client, counterIndex);
	await index.add([{ n: 3, label: 'stale' }], { wait: true });

	const report = await createSearchSync({
		collection,
		index,
		toIndexId: (id) => id,
		transform: (counter) => ({ n: counter._id, label: counter.label }),
	}).reindex();

	expect(report).toEqual({ indexed: 2, skipped: 0, removed: 1 });
	const { results } = await index.list({ sort: [] });
	expect(results.map((hit) => hit.n).sort()).toEqual([1, 2]);
});

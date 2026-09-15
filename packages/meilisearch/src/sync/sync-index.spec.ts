import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { type Movie, movies } from '../../test/movies';
import { startMeilisearch, type TestServer } from '../../test/server';
import { defineIndex } from '../definition/define-index';
import { SearchIndexError } from '../errors/search-index-error';
import { syncIndex, syncIndexes } from './sync-index';

let t: TestServer;

beforeAll(async () => {
	t = await startMeilisearch();
}, 60_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** Every task the server holds for an index, of any status. */
const taskCount = async (uid: string) =>
	(await t.client.tasks.getTasks({ indexUids: [uid], limit: 1 })).total;

describe('syncIndex', () => {
	test('creates a missing index with its primary key and settings', async () => {
		const report = await syncIndex(t.client, movies);
		expect(report.created).toBe(true);
		expect(report.primaryKeySet).toBe(false);
		expect(report.dryRun).toBe(false);
		expect(report.changed.sort() as string[]).toEqual(
			Object.keys(movies.settings)
				// displayedAttributes: ['*'] is the default: nothing to change.
				.filter((name) => name !== 'displayedAttributes')
				.sort(),
		);
		expect(report.tasks.map((task) => [task.type, task.status])).toEqual([
			['indexCreation', 'succeeded'],
			['settingsUpdate', 'succeeded'],
		]);

		const index = await t.client.getRawIndex('movies');
		expect(index.primaryKey).toBe('id');
		const settings = await t.client.index('movies').getSettings();
		expect(settings.sortableAttributes).toEqual(['rating', 'year']);
		expect(settings.searchableAttributes).toEqual([
			'title',
			'overview',
			'director.name',
		]);
		expect(settings.typoTolerance?.minWordSizeForTypos).toEqual({
			oneTypo: 4,
			twoTypos: 9,
		});
	});

	test('a second run in a row sends no task', async () => {
		await syncIndex(t.client, movies);
		const before = await taskCount('movies');

		const report = await syncIndex(t.client, movies);
		expect(report).toEqual({
			uid: 'movies',
			created: false,
			primaryKeySet: false,
			changed: [],
			update: {},
			tasks: [],
			dryRun: false,
		});
		expect(await taskCount('movies')).toBe(before);
	});

	test('updates only the settings that changed, in one task', async () => {
		await syncIndex(t.client, movies);
		const changed = defineIndex<Movie>()({
			uid: 'movies',
			primaryKey: 'id',
			settings: {
				...movies.settings,
				sortableAttributes: ['year'],
				stopWords: ['the'],
			},
		});

		const report = await syncIndex(t.client, changed);
		expect(report.changed.sort() as string[]).toEqual([
			'sortableAttributes',
			'stopWords',
		]);
		expect(report.update).toEqual({
			sortableAttributes: ['year'],
			stopWords: ['the'],
		});
		expect(report.tasks).toHaveLength(1);
		expect(
			(await t.client.index('movies').getSettings()).sortableAttributes,
		).toEqual(['year']);
	});

	test('leaves a setting the definition does not name as it is', async () => {
		const bare = defineIndex<{ id: string }>()({
			uid: 'bare',
			primaryKey: 'id',
		});
		await t.client.createIndex('bare', { primaryKey: 'id' }).waitTask();
		await t.client.index('bare').updateStopWords(['le', 'la']).waitTask();

		const report = await syncIndex(t.client, bare);
		expect(report.changed).toEqual([]);
		expect(await t.client.index('bare').getStopWords()).toEqual(['la', 'le']);
	});

	test('gives an index without a primary key the definition’s', async () => {
		await t.client.createIndex('movies').waitTask();

		const report = await syncIndex(t.client, movies);
		expect(report.created).toBe(false);
		expect(report.primaryKeySet).toBe(true);
		expect(report.tasks[0]?.type).toBe('indexUpdate');
		expect((await t.client.getRawIndex('movies')).primaryKey).toBe('id');
	});

	test('throws PRIMARY_KEY_MISMATCH for an index with another primary key', async () => {
		await t.client.createIndex('movies', { primaryKey: 'slug' }).waitTask();
		const before = await taskCount('movies');

		const error = await syncIndex(t.client, movies).catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('PRIMARY_KEY_MISMATCH');
		expect(error.indexUid).toBe('movies');
		expect(error.expectedPrimaryKey).toBe('id');
		expect(error.actualPrimaryKey).toBe('slug');
		expect(error.message).toStartWith(
			'Index "movies" has the primary key "slug", but its definition says "id".',
		);
		expect(await taskCount('movies')).toBe(before);
	});

	test('a dry run reports and sends nothing', async () => {
		const missing = await syncIndex(t.client, movies, { dryRun: true });
		expect(missing.created).toBe(true);
		expect(missing.dryRun).toBe(true);
		expect(missing.tasks).toEqual([]);
		expect(missing.changed).toContain('sortableAttributes');
		expect(await t.client.getRawIndexes()).toMatchObject({ total: 0 });

		await syncIndex(t.client, movies);
		const before = await taskCount('movies');
		const synced = await syncIndex(t.client, movies, { dryRun: true });
		expect(synced.changed).toEqual([]);
		expect(await taskCount('movies')).toBe(before);
	});
});

describe('syncIndexes', () => {
	test('syncs each definition in order, and reports each', async () => {
		const tags = defineIndex<{ slug: string; label: string }>()({
			uid: 'tags',
			primaryKey: 'slug',
			settings: { searchableAttributes: ['label'] },
		});

		const reports = await syncIndexes(t.client, [movies, tags]);
		expect(reports.map((r) => [r.uid, r.created])).toEqual([
			['movies', true],
			['tags', true],
		]);
		expect((await t.client.getRawIndex('tags')).primaryKey).toBe('slug');

		const again = await syncIndexes(t.client, [movies, tags]);
		expect(again.flatMap((r) => r.tasks)).toEqual([]);
	});
});

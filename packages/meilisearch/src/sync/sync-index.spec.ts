import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { type Meilisearch, MeilisearchApiError, type Task } from 'meilisearch';
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

	test('brings the settings a server rewrites in line, and matches them again', async () => {
		// Meilisearch reads these back sorted, merged into its defaults, or in
		// another shape than they were sent: this is what `sync` has to match.
		const wide = defineIndex<Movie>()({
			uid: 'movies',
			primaryKey: 'id',
			settings: {
				displayedAttributes: ['title', 'year'],
				distinctAttribute: 'title',
				dictionary: ['W. E. B.', 'J. R. R.'],
				separatorTokens: ['|', '&'],
				nonSeparatorTokens: ['@', '#'],
				stopWords: ['the', 'a'],
				synonyms: { car: ['automobile'] },
				searchCutoffMs: 150,
				localizedAttributes: [
					{ attributePatterns: ['title'], locales: ['fra', 'eng'] },
				],
				facetSearch: false,
				prefixSearch: 'disabled',
				proximityPrecision: 'byAttribute',
				pagination: { maxTotalHits: 500 },
				faceting: { maxValuesPerFacet: 42 },
				typoTolerance: { disableOnNumbers: true },
			},
		});

		const first = await syncIndex(t.client, wide);
		expect(first.changed.sort() as string[]).toEqual(
			Object.keys(wide.settings).sort(),
		);
		const live = await t.client.index('movies').getSettings();
		expect(live.searchCutoffMs).toBe(150);
		expect(live.localizedAttributes).toEqual([
			{ attributePatterns: ['title'], locales: ['fra', 'eng'] },
		]);
		// Sorted, merged with the defaults, and untouched: the three shapes.
		expect(live.dictionary).toEqual(['J. R. R.', 'W. E. B.']);
		expect(live.faceting).toEqual({
			maxValuesPerFacet: 42,
			sortFacetValuesBy: { '*': 'alpha' },
		});
		expect(live.synonyms).toEqual({ car: ['automobile'] });

		const second = await syncIndex(t.client, wide);
		expect(second.changed).toEqual([]);
		expect(second.tasks).toEqual([]);
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

	test('a dry run reports the primary key it would set, and sets none', async () => {
		await t.client.createIndex('movies').waitTask();
		const before = await taskCount('movies');

		const report = await syncIndex(t.client, movies, { dryRun: true });
		expect(report.created).toBe(false);
		expect(report.primaryKeySet).toBe(true);
		expect(report.tasks).toEqual([]);
		expect(report.changed).toContain('sortableAttributes');
		expect((await t.client.getRawIndex('movies')).primaryKey).toBeNull();
		expect(await taskCount('movies')).toBe(before);
	});
});

/**
 * The branches a real server does not reach: a failed settings task, which
 * Meilisearch answers `succeeded` for even on absurd values, and the race of
 * two syncs creating the same index. The client is scripted instead.
 */
describe('syncIndex, on a scripted client', () => {
	const scriptedTask = (overrides: Partial<Task>): Task => ({
		uid: 1,
		batchUid: 1,
		indexUid: 'movies',
		status: 'succeeded',
		type: 'indexCreation',
		canceledBy: null,
		error: null,
		duration: 'PT0.01S',
		enqueuedAt: '2026-09-15T00:00:00Z',
		startedAt: '2026-09-15T00:00:00Z',
		finishedAt: '2026-09-15T00:00:00Z',
		...overrides,
	});

	const failure = (code: string, message: string) => ({
		message,
		code,
		type: 'invalid_request',
		link: `https://docs.meilisearch.com/errors#${code}`,
	});

	function scriptedClient(answers: {
		/** What each `getRawIndex` answers, in order; `undefined` is a 404. */
		indexes: (Record<string, unknown> | undefined)[];
		createIndex?: Task;
		updateSettings?: Task;
		settings?: Record<string, unknown>;
	}) {
		const sent: string[] = [];
		const indexes = [...answers.indexes];
		const client = {
			getRawIndex: async () => {
				const next = indexes.shift();
				if (!next) {
					throw new MeilisearchApiError(
						new Response(null, { status: 404 }),
						failure('index_not_found', 'Index `movies` not found.'),
					);
				}
				return next;
			},
			createIndex: () => {
				sent.push('createIndex');
				return {
					waitTask: async () => answers.createIndex ?? scriptedTask({}),
				};
			},
			updateIndex: () => {
				sent.push('updateIndex');
				return { waitTask: async () => scriptedTask({ type: 'indexUpdate' }) };
			},
			index: () => ({
				getSettings: async () => answers.settings ?? {},
				updateSettings: () => {
					sent.push('updateSettings');
					return {
						waitTask: async () =>
							answers.updateSettings ??
							scriptedTask({ type: 'settingsUpdate' }),
					};
				},
			}),
		};
		return { client: client as unknown as Meilisearch, sent };
	}

	test('goes on with the index another sync created in between', async () => {
		const { client, sent } = scriptedClient({
			indexes: [undefined, { uid: 'movies', primaryKey: 'id' }],
			createIndex: scriptedTask({
				status: 'failed',
				error: failure(
					'index_already_exists',
					'Index `movies` already exists.',
				),
			}),
			settings: { ...movies.settings },
		});

		const report = await syncIndex(client, movies);
		expect(report.created).toBe(false);
		expect(report.primaryKeySet).toBe(false);
		// The failed creation is not one of the sync's tasks, and nothing else
		// was sent: the settings already match.
		expect(report.tasks).toEqual([]);
		expect(report.changed).toEqual([]);
		expect(sent).toEqual(['createIndex']);
	});

	test('throws TASK_FAILED when the creation fails for another reason', async () => {
		const { client } = scriptedClient({
			indexes: [],
			createIndex: scriptedTask({
				status: 'failed',
				error: failure('internal', 'An internal error has occurred.'),
			}),
		});

		const error = await syncIndex(client, movies).catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('TASK_FAILED');
		expect(error.task.type).toBe('indexCreation');
		expect(error.cause.code).toBe('internal');
	});

	test('throws TASK_FAILED when the settings update fails', async () => {
		const { client, sent } = scriptedClient({
			indexes: [{ uid: 'movies', primaryKey: 'id' }],
			settings: {},
			updateSettings: scriptedTask({
				type: 'settingsUpdate',
				status: 'failed',
				error: failure(
					'invalid_settings_sortable_attributes',
					'Attribute `year` is not sortable.',
				),
			}),
		});

		const error = await syncIndex(client, movies).catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.message).toBe(
			'Task 1 (sync) on index "movies" failed: invalid_settings_sortable_attributes',
		);
		expect(error.task.type).toBe('settingsUpdate');
		expect(error.cause.message).toBe('Attribute `year` is not sortable.');
		expect(sent).toEqual(['updateSettings']);
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

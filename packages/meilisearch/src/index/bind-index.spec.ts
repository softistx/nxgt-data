import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { MeilisearchApiError } from 'meilisearch';
import { type Movie, movies, sampleMovies } from '../../test/movies';
import { startMeilisearch, type TestServer } from '../../test/server';
import { SearchIndexError } from '../errors/search-index-error';
import { bindIndex } from './bind-index';

const [alien, bladeRunner, heat] = sampleMovies as [Movie, Movie, Movie, Movie];

let t: TestServer;

beforeAll(async () => {
	t = await startMeilisearch();
}, 60_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** The movies index, synced and filled. */
async function filled() {
	const index = bindIndex(t.client, movies);
	await index.sync();
	await index.add(sampleMovies, { wait: true });
	return index;
}

describe('writes', () => {
	test('add with wait resolves to the succeeded task', async () => {
		const index = bindIndex(t.client, movies);
		await index.sync();
		const task = await index.add(sampleMovies, { wait: true });
		expect(task.status).toBe('succeeded');
		expect(task.type).toBe('documentAdditionOrUpdate');
		expect(task.details?.indexedDocuments).toBe(4);
	});

	test('add without wait resolves to the enqueued task', async () => {
		const index = bindIndex(t.client, movies);
		const enqueued = index.add(sampleMovies);
		const { taskUid, status } = await enqueued;
		expect(typeof taskUid).toBe('number');
		expect(status).toBe('enqueued');
		expect((await enqueued.waitTask()).status).toBe('succeeded');
	});

	test('a write before any sync creates the index with the primary key', async () => {
		const index = bindIndex(t.client, movies);
		await index.add([{ ...alien, id: 9 }], { wait: true });
		expect((await t.client.getRawIndex('movies')).primaryKey).toBe('id');
	});

	test('add replaces a document; update merges into it', async () => {
		const index = await filled();
		await index.update([{ id: 1, rating: 9 }], { wait: true });
		expect(await index.get(1)).toEqual({ ...alien, rating: 9 });

		const { title, id, ...rest } = bladeRunner;
		await index.add([{ ...rest, id, title: 'Blade Runner 2049' }], {
			wait: true,
		});
		expect((await index.get(2))?.title).toBe('Blade Runner 2049');
	});

	test('a failed task, waited for, throws TASK_FAILED', async () => {
		const index = bindIndex(t.client, movies);
		await index.sync();
		const bad = { ...alien, id: 'not an id' as unknown as number };
		const error = await index.add([bad], { wait: true }).catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('TASK_FAILED');
		expect(error.task.status).toBe('failed');
		expect(error.task.error.code).toBe('invalid_document_id');
	});

	test('delete by id, by ids, and deleteAll', async () => {
		const index = await filled();
		await index.delete(1, { wait: true });
		expect(await index.get(1)).toBeUndefined();
		await index.delete([2, 3], { wait: { timeout: 10_000 } });
		expect((await index.list()).results.map((m) => m.id)).toEqual([4]);
		await index.deleteAll({ wait: true });
		expect((await index.list()).total).toBe(0);
		// The index and its settings stay.
		expect(
			(await t.client.index('movies').getSettings()).sortableAttributes,
		).toEqual(['rating', 'year']);
	});

	test('deleteByFilter deletes what the filter matches, and nothing else', async () => {
		const index = await filled();
		const task = await index.deleteByFilter('year > 1990', { wait: true });
		expect(task.type).toBe('documentDeletion');
		expect(task.details?.deletedDocuments).toBe(2);
		expect((await index.list()).results.map((m) => m.id)).toEqual([1, 2]);
		await index.deleteByFilter(['genres = scifi', 'year < 1980'], {
			wait: true,
		});
		expect((await index.list()).results.map((m) => m.id)).toEqual([2]);
	});

	test('deleteByFilter on an attribute that is not filterable throws TASK_FAILED', async () => {
		const index = await filled();
		const error = await index
			.deleteByFilter('rating > 8', { wait: true })
			.catch((e) => e);
		expect(error).toBeInstanceOf(SearchIndexError);
		expect(error.code).toBe('TASK_FAILED');
		expect(error.task.error.code).toBe('invalid_document_filter');
		expect((await index.list()).total).toBe(4);
	});

	test('deleteByFilter with an empty filter is refused by the server', async () => {
		const index = await filled();
		const error = await index.deleteByFilter('  ').catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause?.code).toBe('invalid_document_filter');
		expect((await index.list()).total).toBe(4);
	});

	test('addInBatches and updateInBatches send one task per batch', async () => {
		const index = bindIndex(t.client, movies);
		await index.sync();
		const tasks = await index.addInBatches(sampleMovies, {
			batchSize: 3,
			wait: true,
		});
		expect(tasks.map((task) => task.details?.receivedDocuments)).toEqual([
			3, 1,
		]);

		const enqueued = index.updateInBatches(
			sampleMovies.map(({ id }) => ({ id, rating: 5 })),
			{ batchSize: 2 },
		);
		expect(enqueued).toHaveLength(2);
		await Promise.all(enqueued.map((task) => task.waitTask()));
		expect((await index.getMany([1, 4])).map((m) => m.rating)).toEqual([5, 5]);
	});

	test('customMetadata is kept on the task', async () => {
		const index = await filled();
		const deleted = await index.delete(1, {
			wait: true,
			customMetadata: 'from-the-spec',
		});
		expect(deleted.customMetadata).toBe('from-the-spec');
		const added = await index.add([alien], {
			wait: true,
			customMetadata: 'again',
		});
		expect(added.customMetadata).toBe('again');
	});
});

describe('reads', () => {
	test('get returns the document, or undefined', async () => {
		const index = await filled();
		expect(await index.get(3)).toEqual(heat);
		expect(await index.get(42)).toBeUndefined();
	});

	test('get and getMany return only the fields asked for', async () => {
		const index = await filled();
		expect(await index.get(1, { fields: ['title', 'year'] })).toEqual({
			title: 'Alien',
			year: 1979,
		});
		expect(
			await index.getMany([4, 1], { fields: ['id', 'title'] }),
		).toContainEqual({ id: 4, title: 'Arrival' });
	});

	test('getMany leaves missing ids out, and [] asks for nothing', async () => {
		const index = await filled();
		const found = await index.getMany([2, 3, 99]);
		expect(found.map((m) => m.id).sort()).toEqual([2, 3]);
		expect(await index.getMany([])).toEqual([]);
	});

	test('get on an index that does not exist throws the SDK’s error', async () => {
		// Only a missing *document* is `undefined`; a missing index is a fault.
		const index = bindIndex(t.client, movies);
		const error = await index.get(1).catch((e) => e);
		expect(error).toBeInstanceOf(MeilisearchApiError);
		expect(error.cause.code).toBe('index_not_found');
	});

	test('list takes an offset', async () => {
		const index = await filled();
		const page = await index.list({
			sort: ['year:asc'],
			offset: 2,
			limit: 2,
			fields: ['title'],
		});
		expect(page).toEqual({
			results: [{ title: 'Heat' }, { title: 'Arrival' }],
			total: 4,
			offset: 2,
			limit: 2,
		});
	});

	test('list filters, sorts and pages', async () => {
		const index = await filled();
		const page = await index.list({
			filter: 'genres = scifi',
			sort: ['year:desc'],
			limit: 2,
			fields: ['title'],
		});
		expect(page).toEqual({
			results: [{ title: 'Arrival' }, { title: 'Blade Runner' }],
			total: 3,
			offset: 0,
			limit: 2,
		});
	});
});

describe('search', () => {
	test('returns documents as hits', async () => {
		const index = await filled();
		const result = await index.search('replicants');
		expect(result.hits).toHaveLength(1);
		const hit: Movie | undefined = result.hits[0];
		expect(hit?.title).toBe('Blade Runner');
		expect(result.estimatedTotalHits).toBe(1);
	});

	test('sorts, filters and facets on the definition’s attributes', async () => {
		const index = await filled();
		const result = await index.search('', {
			filter: ['director.name = "Ridley Scott"'],
			sort: ['year:desc'],
			facets: ['genres'],
		});
		expect(result.hits.map((m) => m.title)).toEqual(['Blade Runner', 'Alien']);
		expect(result.facetDistribution?.genres).toEqual({
			scifi: 2,
			horror: 1,
			noir: 1,
		});
	});

	test('page and hitsPerPage give a numbered page', async () => {
		const index = await filled();
		const result = await index.search('', {
			page: 2,
			hitsPerPage: 3,
			sort: ['rating:desc'],
			attributesToRetrieve: ['id'],
		});
		expect(result.totalPages).toBe(2);
		expect(result.totalHits).toBe(4);
		// attributesToRetrieve does not narrow the hit type: see Traps.
		expect(result.hits as unknown[]).toEqual([{ id: 4 }]);
	});

	test('highlights and restricts the search to searchable attributes', async () => {
		const index = await filled();
		const result = await index.search('space', {
			attributesToSearchOn: ['overview'],
			attributesToHighlight: ['overview'],
		});
		expect(result.hits.map((m) => m.id).sort()).toEqual([1, 4]);
		expect(result.hits[0]?._formatted?.overview).toContain('<em>space</em>');
	});
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MeilisearchApiError } from 'meilisearch';
import { movies, sampleMovies } from '../../test/movies';
import { startMeilisearch, type TestServer } from '../../test/server';
import { defineIndex } from '../definition/define-index';
import { bindIndex } from '../index/bind-index';
import { multiSearch } from './multi-search';

interface Person {
	slug: string;
	name: string;
	born: number;
	country: string;
}

const people = defineIndex<Person>()({
	uid: 'people',
	primaryKey: 'slug',
	settings: {
		filterableAttributes: ['country'],
		sortableAttributes: ['born'],
	},
});

const directors: Person[] = [
	{ slug: 'ridley-scott', name: 'Ridley Scott', born: 1937, country: 'UK' },
	{ slug: 'michael-mann', name: 'Michael Mann', born: 1943, country: 'US' },
	{ slug: 'tony-scott', name: 'Tony Scott', born: 1944, country: 'UK' },
];

let t: TestServer;

beforeAll(async () => {
	t = await startMeilisearch();
}, 60_000);
beforeEach(() => t.reset());
afterAll(() => t.stop());

/** Both indexes, synced and filled. */
async function filled() {
	const movieIndex = bindIndex(t.client, movies);
	const peopleIndex = bindIndex(t.client, people);
	await movieIndex.sync();
	await peopleIndex.sync();
	await movieIndex.add(sampleMovies, { wait: true });
	await peopleIndex.add(directors, { wait: true });
	return { movieIndex, peopleIndex };
}

test('each query runs on its own index, and the results come back in order', async () => {
	const { movieIndex, peopleIndex } = await filled();
	const [films, persons] = await multiSearch(t.client, [
		{
			index: movieIndex,
			filter: 'genres = scifi',
			sort: ['year:desc'],
			facets: ['genres'],
		},
		{
			index: peopleIndex,
			q: 'scott',
			filter: 'country = UK',
			sort: ['born:desc'],
		},
	]);
	expect(films.indexUid).toBe('movies');
	expect(films.hits.map((m) => m.title)).toEqual([
		'Arrival',
		'Blade Runner',
		'Alien',
	]);
	expect(films.facetDistribution?.genres).toEqual({
		drama: 1,
		horror: 1,
		noir: 1,
		scifi: 3,
	});
	expect(persons.indexUid).toBe('people');
	expect(persons.hits.map((p) => p.slug)).toEqual([
		'tony-scott',
		'ridley-scott',
	]);
});

test('each query keeps its own pagination', async () => {
	const { movieIndex, peopleIndex } = await filled();
	const [numbered, offset] = await multiSearch(t.client, [
		{ index: movieIndex, page: 2, hitsPerPage: 3, sort: ['rating:desc'] },
		{ index: peopleIndex, limit: 1, sort: ['born:asc'] },
	]);
	expect(numbered.totalPages).toBe(2);
	expect(numbered.totalHits).toBe(4);
	expect(numbered.hits.map((m) => m.id)).toEqual([4]);
	expect(offset.estimatedTotalHits).toBe(3);
	expect(offset.hits.map((p) => p.slug)).toEqual(['ridley-scott']);
});

test('the same index twice is two results', async () => {
	const { movieIndex } = await filled();
	const results = await multiSearch(t.client, [
		{ index: movieIndex, q: 'alien' },
		{ index: movieIndex, q: 'heat' },
	]);
	expect(results.map((r) => r.hits.map((m) => m.title))).toEqual([
		['Alien'],
		['Heat'],
	]);
});

test('no query is no result, and no request refused', async () => {
	expect(await multiSearch(t.client, [])).toEqual([]);
});

test('a query on an index that does not exist fails the whole request with the SDK’s error', async () => {
	const { movieIndex } = await filled();
	const error = await multiSearch(t.client, [
		{ index: movieIndex, q: 'alien' },
		{
			index: bindIndex(
				t.client,
				defineIndex<Person>()({ uid: 'nobody', primaryKey: 'slug' }),
			),
		},
	]).catch((e) => e);
	expect(error).toBeInstanceOf(MeilisearchApiError);
	expect(error.cause.code).toBe('index_not_found');
	expect(error.message).toBe('Inside `.queries[1]`: Index `nobody` not found.');
});

test('a sort the live index does not allow fails the request, naming the query', async () => {
	// The types check against the definition; the server against its settings.
	const { movieIndex } = await filled();
	const unsynced = bindIndex(
		t.client,
		defineIndex<Person>()({
			uid: 'movies',
			primaryKey: 'slug',
			settings: { sortableAttributes: ['name'] },
		}),
	);
	const error = await multiSearch(t.client, [
		{ index: movieIndex },
		{ index: unsynced, sort: ['name:asc'] },
	]).catch((e) => e);
	expect(error).toBeInstanceOf(MeilisearchApiError);
	expect(error.cause.code).toBe('invalid_search_sort');
	expect(error.message).toStartWith(
		'Inside `.queries[1]`: Index `movies`: Attribute `name` is not sortable.',
	);
});

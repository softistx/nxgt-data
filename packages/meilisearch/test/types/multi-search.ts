// Type tests for `multiSearch`, checked by `tsc --noEmit` and never run.

import type { Meilisearch } from 'meilisearch';
import { bindIndex, defineIndex, multiSearch } from '../../src';
import { type Movie, movies } from '../movies';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const client: Meilisearch;

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

const movieIndex = bindIndex(client, movies);
const peopleIndex = bindIndex(client, people);

// Each result is typed by its own index, by position.
const [films, persons] = await multiSearch(client, [
	{ index: movieIndex, q: 'alien', sort: ['year:desc'], facets: ['genres'] },
	{
		index: peopleIndex,
		q: 'ridley',
		sort: ['born:asc'],
		filter: 'country = UK',
	},
]);
assertType<Equal<(typeof films.hits)[number]['director']['name'], string>>(
	true,
);
assertType<Equal<(typeof persons.hits)[number]['born'], number>>(true);
assertType<Equal<typeof films.estimatedTotalHits, number>>(true);
assertType<Equal<typeof films.indexUid, string>>(true);
// @ts-expect-error a person has no director
persons.hits[0]?.director;
// @ts-expect-error two queries, two results
const [, , third] = await multiSearch(client, [
	{ index: movieIndex },
	{ index: peopleIndex },
]);
void third;

// Pagination follows each query's own options.
const [numbered, offset] = await multiSearch(client, [
	{ index: movieIndex, page: 1, hitsPerPage: 10 },
	{ index: peopleIndex, limit: 5 },
]);
assertType<Equal<typeof numbered.totalPages, number>>(true);
assertType<Equal<typeof offset.estimatedTotalHits, number>>(true);

// The same index twice is two results of the same type.
const twice = await multiSearch(client, [
	{ index: movieIndex, q: 'alien' },
	{ index: movieIndex, q: 'heat' },
]);
assertType<Equal<(typeof twice)[1]['hits'][number]['title'], string>>(true);
const hit: Movie | undefined = twice[1].hits[0];
void hit;
assertType<Equal<typeof twice.length, 2>>(true);

await multiSearch(client, [
	{ index: movieIndex, sort: ['year:desc'] },
	// @ts-expect-error year is a movie's sortable attribute, not a person's
	{ index: peopleIndex, sort: ['year:desc'] },
]);
await multiSearch(client, [
	// @ts-expect-error born is a person's sortable attribute, not a movie's
	{ index: movieIndex, sort: ['born:asc'] },
	{ index: peopleIndex, sort: ['born:asc'] },
]);
await multiSearch(client, [
	{ index: movieIndex },
	// @ts-expect-error name is not filterable on people
	{ index: peopleIndex, facets: ['name'] },
]);
await multiSearch(client, [
	{ index: movieIndex },
	// @ts-expect-error born is not filterable on people
	{ index: peopleIndex, distinct: 'born' },
]);
await multiSearch(client, [
	// @ts-expect-error not a search option
	{ index: movieIndex, sortBy: ['year:desc'] },
]);
await multiSearch(client, [
	// @ts-expect-error the index is a bound index, not a uid
	{ indexUid: 'movies', q: 'alien' },
]);
// @ts-expect-error federation is not wrapped: use client.multiSearch
await multiSearch(client, [{ index: movieIndex }], { federation: {} });

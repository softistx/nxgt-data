// Type tests, checked by `tsc --noEmit` and never run. Each `@ts-expect-error`
// is a line that must not compile: if it compiles, tsc reports the unused
// directive.

import type { EnqueuedTaskPromise, Meilisearch, Task } from 'meilisearch';
import {
	bindIndex,
	type DocumentPath,
	defineIndex,
	type IdOf,
	type SortableOf,
	syncIndexes,
} from '../../src';
import { type Movie, movies } from '../movies';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
function assertType<T extends true>(_: T): void {}

declare const client: Meilisearch;

// Paths: the keys, and dot paths into nested objects and arrays of them.
type Post = {
	id: string;
	title: string;
	tags: string[];
	author: { name: string; address: { city: string } };
	comments: { body: string; at: Date }[];
};
assertType<
	Equal<
		DocumentPath<Post>,
		| 'id'
		| 'title'
		| 'tags'
		| 'author'
		| 'author.name'
		| 'author.address'
		| 'author.address.city'
		| 'comments'
		| 'comments.body'
		| 'comments.at'
	>
>(true);

// The settings take the document's attributes, and keep their literals.
assertType<Equal<SortableOf<typeof movies>, 'year' | 'rating'>>(true);
assertType<Equal<IdOf<typeof movies>, number>>(true);
assertType<Equal<(typeof movies)['uid'], 'movies'>>(true);

defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	settings: { filterableAttributes: ['director.country'] },
});
defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	// @ts-expect-error not an attribute of Movie
	settings: { sortableAttributes: ['nope'] },
});
defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	// @ts-expect-error not an attribute of Movie
	settings: { searchableAttributes: ['title', 'director.age'] },
});
defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	// @ts-expect-error not a setting
	settings: { sortableAttribute: ['year'] },
});
defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	// @ts-expect-error a custom ranking rule on no attribute
	settings: { rankingRules: ['words', 'nope:desc'] },
});
defineIndex<Movie>()({
	uid: 'm',
	// @ts-expect-error an array cannot be the primary key
	primaryKey: 'genres',
});
defineIndex<Movie>()({
	uid: 'm',
	// @ts-expect-error not an attribute of Movie
	primaryKey: 'slug',
});
defineIndex<Movie>()({
	uid: 'm',
	primaryKey: 'id',
	settings: {
		filterableAttributes: [
			'year',
			{
				attributePatterns: ['director.*'],
				features: {
					facetSearch: false,
					filter: { equality: true, comparison: false },
				},
			},
		],
		faceting: { sortFacetValuesBy: { '*': 'alpha', genres: 'count' } },
		// @ts-expect-error not a proximity precision
		proximityPrecision: 'byLetter',
	},
});

const index = bindIndex(client, movies);
declare const movie: Movie;

// Documents have the document's shape.
index.add([movie]);
// @ts-expect-error a document with attributes missing
index.add([{ id: 1, title: 'Alien' }]);
// @ts-expect-error year is a number
index.add([{ ...movie, year: '1979' }]);
// update takes a partial document, with its id.
index.update([{ id: 1, rating: 9 }]);
// @ts-expect-error the id is required
index.update([{ rating: 9 }]);

// The id type is the primary key's.
await index.get(1);
// @ts-expect-error the id is a number
await index.get('1');
// @ts-expect-error the ids are numbers
index.delete(['1', '2']);
index.delete([1, 2]);

// get and getMany narrow to the fields asked for.
const full = await index.get(1);
assertType<Equal<typeof full, Movie | undefined>>(true);
const picked = await index.get(1, { fields: ['title', 'year'] });
assertType<Equal<typeof picked, Pick<Movie, 'title' | 'year'> | undefined>>(
	true,
);
// @ts-expect-error not an attribute of Movie
await index.getMany([1], { fields: ['nope'] });

// A write is the SDK's enqueued task, or with wait the finished one.
assertType<Equal<ReturnType<typeof index.deleteAll>, EnqueuedTaskPromise>>(
	true,
);
const enqueued = index.add([movie]);
assertType<Equal<typeof enqueued, EnqueuedTaskPromise>>(true);
const waited = index.add([movie], { wait: true });
assertType<Equal<typeof waited, Promise<Task>>>(true);
const timed = index.delete(1, { wait: { timeout: 1000 } });
assertType<Equal<typeof timed, Promise<Task>>>(true);
const batches = index.addInBatches([movie], { batchSize: 10, wait: true });
assertType<Equal<typeof batches, Promise<Task[]>>>(true);

// Hits are documents.
const result = await index.search('alien', { sort: ['year:desc'] });
assertType<Equal<(typeof result.hits)[number]['director']['name'], string>>(
	true,
);
assertType<Equal<typeof result.estimatedTotalHits, number>>(true);
const paged = await index.search('alien', { page: 1, hitsPerPage: 10 });
assertType<Equal<typeof paged.totalPages, number>>(true);

// sort, facets and distinct follow the definition.
// @ts-expect-error title is not sortable
await index.search('alien', { sort: ['title:asc'] });
// @ts-expect-error not a direction
await index.search('alien', { sort: ['year:up'] });
await index.search('', { facets: ['genres', 'director.name'] });
// @ts-expect-error rating is not filterable
await index.search('', { facets: ['rating'] });
// @ts-expect-error rating is not filterable
await index.search('', { distinct: 'rating' });
await index.search('', { attributesToRetrieve: ['title', 'director.name'] });
// @ts-expect-error not an attribute of Movie
await index.search('', { attributesToHighlight: ['nope'] });
// @ts-expect-error year is not searchable
await index.search('', { attributesToSearchOn: ['year'] });
// filter stays the SDK's string or array.
await index.search('', { filter: 'year > 1990 AND genres = scifi' });
await index.list({ filter: ['genres = scifi'], sort: ['rating:asc'] });
// @ts-expect-error title is not sortable
await index.list({ sort: ['title:asc'] });

// An index with no sortable attributes sorts on nothing.
const tags = defineIndex<{ slug: string; label: string }>()({
	uid: 'tags',
	primaryKey: 'slug',
});
// @ts-expect-error no sortable attributes
await bindIndex(client, tags).search('', { sort: ['label:asc'] });
await bindIndex(client, tags).get('drizzle');

// Definitions of different documents sync together.
await syncIndexes(client, [movies, tags]);

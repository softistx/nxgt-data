// Type tests, checked by `tsc --noEmit` and never run. Each `@ts-expect-error`
// is a line that must not compile: if it compiles, tsc reports the unused
// directive.

import type {
	EnqueuedTaskPromise,
	Meilisearch,
	Settings,
	Task,
} from 'meilisearch';
import {
	bindIndex,
	type DocumentPath,
	defineIndex,
	diffSettings,
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
const filtered = index.deleteByFilter('year > 1990', { wait: true });
assertType<Equal<typeof filtered, Promise<Task>>>(true);
assertType<Equal<ReturnType<typeof index.deleteByFilter>, EnqueuedTaskPromise>>(
	true,
);
// @ts-expect-error a filter is a string or an array, not an object
index.deleteByFilter({ year: 1990 });
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

// A write option is the SDK's, typed.
index.add([movie], { customMetadata: 'import-42' });
// @ts-expect-error customMetadata is a string
index.add([movie], { customMetadata: 42 });
await index.list({ offset: 10, limit: 5 });
// @ts-expect-error update takes the document's attributes
index.update([{ id: 1, year: '1979' }]);

// `_geo`, when it is sortable, allows a geo sort and nothing else does.
const places = defineIndex<{
	id: string;
	name: string;
	_geo: { lat: number; lng: number };
}>()({
	uid: 'places',
	primaryKey: 'id',
	settings: { sortableAttributes: ['_geo', 'name'] },
});
await bindIndex(client, places).search('', {
	sort: ['_geoPoint(48.85, 2.35):asc', 'name:desc'],
});
// @ts-expect-error movies has no _geo
await index.search('', { sort: ['_geoPoint(48.85, 2.35):asc'] });

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

// A definition's own settings go straight into `diffSettings`: they are
// `readonly` — that is what makes `SortableOf` work — and the SDK's `Settings`
// is not, so this used to need a cast at every call site, this package's own
// included.
diffSettings(movies.settings, {});
diffSettings(places.settings, await client.index('places').getSettings());

// And a plain `Settings`, mutable and from anywhere, still goes in.
const mutable: Settings = { sortableAttributes: ['year'], stopWords: ['the'] };
diffSettings(mutable, {});

// What comes back is a `Settings` the SDK will take, not a readonly copy.
const update: Settings = diffSettings(movies.settings, {});
await client.index('movies').updateSettings(update);

// @ts-expect-error the live settings are the server's, and are not readonly
diffSettings({}, movies.settings);

// `WantedSettings` allows every value to be `undefined`, because a definition
// writes `sortFacetValuesBy` as a `Partial<Record<…>>` — and a setting that is
// `undefined` is one `diffSettings` skips. It is no wider than that:
// @ts-expect-error a sortable attribute is a string, not a number
diffSettings({ sortableAttributes: [123] }, {});
// @ts-expect-error there is no such setting
diffSettings({ nonsense: true }, {});
// @ts-expect-error prefixSearch takes two values, and this is not one of them
diffSettings({ prefixSearch: 'sometimes' }, {});
diffSettings({ stopWords: undefined }, {});

// rebuild hands `fill` an index typed by the same definition.
const rebuilt = await index.rebuild(async (next) => {
	// The next index's uid is not the live one's, so it is only a string.
	assertType<Equal<typeof next.definition.uid, string>>(true);
	assertType<Equal<(typeof index.definition)['uid'], 'movies'>>(true);
	await next.add([movie], { wait: true });
	// @ts-expect-error a document with attributes missing
	await next.add([{ id: 1, title: 'Alien' }]);
	// @ts-expect-error title is not sortable, on the next index either
	await next.search('', { sort: ['title:asc'] });
});
assertType<Equal<typeof rebuilt.tasks, Task[]>>(true);
// @ts-expect-error fill must return a promise, so the writes are awaited
await index.rebuild((next) => {
	next.add([movie]);
});
// @ts-expect-error nextUid is a string
await index.rebuild(async () => {}, { nextUid: 42 });

// A literal uid that is empty or holds a space, a `*`, a dot or a slash does
// not compile: a cheap denylist. Anything else a uid may not hold — a unicode
// lookalike, a 401st character — compiles and is refused at run time, as is
// a uid typed `string` or a union of literals.
const versioned = defineIndex<Movie>()({
	uid: 'movies_2026-v2',
	primaryKey: 'id',
});
// The check keeps the literal: it types a tenant token's rule key.
assertType<Equal<(typeof versioned)['uid'], 'movies_2026-v2'>>(true);
// @ts-expect-error a * would widen a tenant token
defineIndex<Movie>()({ uid: '*', primaryKey: 'id' });
// @ts-expect-error a * anywhere in it
defineIndex<Movie>()({ uid: 'movies*', primaryKey: 'id' });
// @ts-expect-error a space
defineIndex<Movie>()({ uid: 'my movies', primaryKey: 'id' });
// @ts-expect-error a dot
defineIndex<Movie>()({ uid: 'movies.v2', primaryKey: 'id' });
// @ts-expect-error a slash
defineIndex<Movie>()({ uid: 'tenant/movies', primaryKey: 'id' });
// @ts-expect-error empty
defineIndex<Movie>()({ uid: '', primaryKey: 'id' });
declare const someUid: string;
defineIndex<Movie>()({ uid: someUid, primaryKey: 'id' });
defineIndex<Movie>()({ uid: 'movies＊', primaryKey: 'id' });

// A generic uid compiles, as it did before the check: runtime only.
function moviesUnder<U extends string>(uid: U) {
	return defineIndex<Movie>()({ uid, primaryKey: 'id' });
}
function docsOf<U extends `docs_${string}`>(uid: U) {
	return defineIndex<Movie>()({ uid, primaryKey: 'id' });
}
assertType<Equal<ReturnType<typeof moviesUnder<'m'>>['uid'], 'm'>>(true);
assertType<Equal<ReturnType<typeof docsOf<'docs_a'>>['uid'], 'docs_a'>>(true);

// A union of literals keeps its members, and compiles even with a bad one
// among them: `define-index.spec.ts` shows the run time refusing it.
declare const either: 'a' | 'b';
const eitherIndex = defineIndex<Movie>()({ uid: either, primaryKey: 'id' });
assertType<Equal<(typeof eitherIndex)['uid'], 'a' | 'b'>>(true);
declare const oneBad: 'movies' | '*';
defineIndex<Movie>()({ uid: oneBad, primaryKey: 'id' });

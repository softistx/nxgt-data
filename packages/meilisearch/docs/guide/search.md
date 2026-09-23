# Searching

`search` is the SDK's search, with the options that name attributes typed by
the [definition](definition.md): a sort on an attribute that is not sortable
does not compile.

```ts
import { movieIndex } from './search';

const result = await movieIndex.search('ridley', {
	filter: ['genres = scifi', 'year > 1980'],
	sort: ['rating:desc'],
	facets: ['genres'],
	limit: 20,
});

result.hits;               // Hit<Movie>[]: the document, plus _formatted and _rankingScore when asked for
result.facetDistribution;  // { genres: { scifi: 2, noir: 1 } }
result.estimatedTotalHits; // 2
```

An empty query returns everything the filter matches, ranked by the sort:
`search('')` and `search(null)` are both allowed.

## What the definition types

| Option | Takes |
| --- | --- |
| `sort` | `'<sortable>:asc'` / `'<sortable>:desc'`, and `'_geoPoint(lat, lng):asc'` when `_geo` is sortable |
| `facets` | filterable attributes, or `'*'` |
| `distinct` | one filterable attribute |
| `attributesToSearchOn` | the `searchableAttributes`, or any attribute when the definition sets `['*']` or none |
| `attributesToRetrieve`, `attributesToHighlight`, `attributesToCrop` | attributes of the document, or `'*'`; `attributesToCrop` also takes `'overview:30'` |

Everything else is the SDK's `SearchParams`, unchanged: `limit`, `offset`,
`page`, `hitsPerPage`, `matchingStrategy`, `showRankingScore`,
`cropLength`, `highlightPreTag`, `hybrid`, `vector`…

```ts
// @ts-expect-error: 'title' is not in sortableAttributes
await movieIndex.search('alien', { sort: ['title:asc'] });
```

**`filter` stays the SDK's string or array of strings.** This package has no
filter builder, so a filter is checked by Meilisearch, at run time:

```ts
await movieIndex.search('', {
	filter: ['genres = scifi', ['year > 1980', 'rating > 8']], // AND of (OR)
});
```

## Two paginations

The default is `offset`/`limit`, with an estimate:

```ts
const result = await movieIndex.search('alien', { limit: 20, offset: 40 });
result.estimatedTotalHits; // an estimate, capped by pagination.maxTotalHits
result.limit;
result.offset;
```

Passing `page` or `hitsPerPage` switches the response to numbered pages —
exact, and slower — **and the type follows**:

```ts
const page = await movieIndex.search('alien', { page: 2, hitsPerPage: 20 });
page.totalHits;  // number
page.totalPages; // number
page.page;
page.hitsPerPage;
```

The two sets do not coexist: with `page`, there is no `estimatedTotalHits`,
and the compiler knows it.

## Highlighting and cropping

```ts
const result = await movieIndex.search('space', {
	attributesToSearchOn: ['overview'],
	attributesToHighlight: ['overview'],
	attributesToCrop: ['overview:20'],
	highlightPreTag: '<mark>',
	highlightPostTag: '</mark>',
});

result.hits[0]?._formatted?.overview; // '…a deadly creature in <mark>space</mark>'
```

`_formatted` holds the highlighted copy; the hit's own attributes are
untouched.

**Narrowing the response does not narrow the type.**
`attributesToRetrieve: ['id']` makes Meilisearch return only `id`, but a hit
is still typed as the whole document — Meilisearch decides that per index and
per query, and the type cannot follow. `get`, `getMany` and `list` do narrow
to their `fields`; see [guide/documents.md](documents.md#reading-by-id).

## Facets

A facet counts the values of a filterable attribute among the hits, which is
what a sidebar of checkboxes needs:

```ts
const result = await movieIndex.search(query, {
	facets: ['genres', 'year'],
	filter: selectedGenres.map((genre) => `genres = "${genre}"`),
});

result.facetDistribution?.genres; // { scifi: 12, noir: 3 }
result.facetStats?.year;          // { min: 1979, max: 2016 }
```

How many values come back, and in which order, is
`faceting.maxValuesPerFacet` and `faceting.sortFacetValuesBy` in the
definition. Searching *within* a facet's values is
`movieIndex.raw.searchForFacetValues`.

## Options in a variable

Options written inline keep their literal types. Lifted into a `const`, they
widen — `['rating:desc']` becomes `string[]`, which `search` refuses. Keep
the literals with `satisfies`:

```ts
import type { SearchOptions } from '@nxgt/meilisearch';
import { movies } from './indexes';

const defaults = {
	sort: ['rating:desc'],
	facets: ['genres'],
	limit: 20,
} satisfies SearchOptions<typeof movies>;

const result = await movieIndex.search(query, defaults);
```

## Several indexes in one request

`multiSearch(client, queries)` sends several searches in one request — the
SDK's `client.multiSearch({ queries })` — and resolves to a tuple: one result
per query, in the same order, each typed by **its own** index.

```ts
import { bindIndex, multiSearch } from '@nxgt/meilisearch';

const movieIndex = bindIndex(client, movies);
const peopleIndex = bindIndex(client, people); // defineIndex<Person>, sortable 'born', filterable 'country'

const [films, persons] = await multiSearch(client, [
	{ index: movieIndex, q: 'alien', filter: 'genres = scifi', sort: ['year:desc'], facets: ['genres'] },
	{ index: peopleIndex, q: 'scott', filter: 'country = UK', sort: ['born:desc'] },
]);
films.hits;     // Hit<Movie>[]
persons.hits;   // Hit<Person>[]
films.indexUid; // 'movies'
```

Each query is `{ index, q?, …options }`, where `index` is a bound index and
the options are exactly those of [`search`](#what-the-definition-types),
typed by that index's definition — `sort: ['year:desc']` on the people
query does not compile, nor does a misspelt option. `page`/`hitsPerPage`
switch the pagination of that result only:

```ts
const [numbered, offset] = await multiSearch(client, [
	{ index: movieIndex, page: 2, hitsPerPage: 20 }, // totalPages, totalHits…
	{ index: peopleIndex, limit: 5 },                // estimatedTotalHits, offset…
]);
```

What was measured, on v1.53.2:

- one query Meilisearch refuses fails **the whole request**, with the SDK's
  `MeilisearchApiError`; its message names the query by position —
  ``Inside `.queries[1]`: Index `nobody` not found.``, or
  ``Inside `.queries[1]`: Index `movies`: Attribute `name` is not sortable.``
  followed by the sortable attributes the index has;
- `multiSearch(client, [])` resolves to `[]`;
- the same index twice is two results.

**Federated search is not wrapped.** With `federation`, Meilisearch merges
every query's hits into one ranked list, so a hit is a document of any of
the indexes, told apart only by `_federation.indexUid`, and
`facetsByIndex`, `mergeFacets` and a federated `distinct` would need typing
per uid too. Call `client.multiSearch({ federation: {}, queries })` for it.

The `client` passed is the one the request goes out on, whatever client each
index was bound with.

## In a Hono route

```ts
import { Hono } from 'hono';
import { movieIndex } from './search';

export const app = new Hono().get('/search', async (c) => {
	const page = Number(c.req.query('page') ?? 1);
	const genres = c.req.queries('genre') ?? [];

	const result = await movieIndex.search(c.req.query('q') ?? '', {
		filter: genres.map((genre) => `genres = "${genre}"`),
		facets: ['genres'],
		sort: ['rating:desc'],
		page,
		hitsPerPage: 20,
		attributesToHighlight: ['title', 'overview'],
	});

	return c.json({
		hits: result.hits,
		facets: result.facetDistribution,
		page: result.page,
		totalPages: result.totalPages,
	});
});
```

A route like this needs a **search-only** key: nothing here creates an index
or changes a setting. Keep the key that [`sync`](sync.md) uses on the server
side only.

## Signatures

```ts
function search<O extends SearchOptions<Def>>(
	query?: string | null,
	options?: O,
): Promise<SearchResult<Def, O>>;

/** The SDK's SearchParams, with the attribute options typed by the definition. */
interface SearchOptions<Def> {
	sort?: readonly SortExpression<Def>[];
	facets?: readonly (FilterableOf<Def> | '*')[];
	distinct?: FilterableOf<Def>;
	attributesToRetrieve?: readonly AttributeOrWildcard<Def>[];
	attributesToHighlight?: readonly AttributeOrWildcard<Def>[];
	attributesToCrop?: readonly (AttributeOrWildcard<Def> | `${DocumentPath<DocumentOf<Def>>}:${number}`)[];
	attributesToSearchOn?: readonly SearchableOf<Def>[] | null;
	// …and every other SearchParams field
}

type SortExpression<Def> =
	| `${SortableOf<Def>}:${OrderDirection}`
	| ('_geo' extends SortableOf<Def> ? `_geoPoint(${string}):${OrderDirection}` : never);

/** The SDK's SearchResponse, its hits typed as the document. */
type SearchResult<Def, Options>;
```

```ts
function multiSearch<const Queries extends readonly { index: TypedIndex<any> }[]>(
	client: Meilisearch,
	queries: Queries & { readonly [K in keyof Queries]: CheckedQuery<Queries[K]> },
): Promise<MultiSearchResults<Queries>>;

/** One query: `search`'s options for that index, plus the index and `q`. */
type MultiSearchQuery<Def> = SearchOptions<Def> & { index: TypedIndex<Def>; q?: string | null };

/** One result per query, in order: `SearchResult<Def, Query> & { indexUid: string }`. */
type MultiSearchResults<Queries>;
```

For `searchForFacetValues`, `searchSimilarDocuments`, federated search or index
stats, `movieIndex.raw` is the SDK's `Index` and `movieIndex.client` its
`Meilisearch`.

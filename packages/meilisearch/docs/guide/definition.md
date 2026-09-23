# Defining an index

One object describes an index: its uid, the attribute that identifies a
document, and its settings — all typed by the document, so a misspelt
attribute does not compile.

```ts
import { defineIndex } from '@nxgt/meilisearch';

export interface Movie {
	id: number;
	title: string;
	overview: string;
	year: number;
	rating: number;
	genres: string[];
	director: { name: string; country: string };
}

export const movies = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		searchableAttributes: ['title', 'overview', 'director.name'],
		filterableAttributes: ['genres', 'year'],
		sortableAttributes: ['year', 'rating'],
	},
});
```

Nothing is sent: `defineIndex` returns the frozen config. The server is
brought in line by [`sync`](sync.md), and the documents and searches are
typed by passing this definition to [`bindIndex`](documents.md).

## The uid

A uid is what Meilisearch accepts, measured on v1.53.2: **1 to 400
characters, each an ASCII letter, a digit, `-` or `_`**. `defineIndex`
refuses anything else with a bare `TypeError`, at definition, before any
request — the message names the call and the shape, never the uid, since one
built from a request should stay out of logs:

```ts
defineIndex<Movie>()({ uid: 'movies_2026-v2', primaryKey: 'id' }); // fine

const tenant = 'acme*'; // from a request
defineIndex<Movie>()({ uid: `docs_${tenant}`, primaryKey: 'id' });
// TypeError: defineIndex: the uid must be 1 to 400 characters, each an ASCII letter, a digit, - or _
```

Refused: an empty string, 401 characters, a `*`, a space, a dot, a slash, a
unicode lookalike (`＊`, a Cyrillic `о`, a no-break space), a trailing
newline, and anything that is not a string. The server refuses each of them
with `invalid_index_uid`; the check moves that refusal to where the uid is
written. A `*` matters beyond the server: a [tenant
token](tenant-tokens.md) reads its rule keys as index **patterns**, so a uid
holding one would widen a token to other indexes.

The types catch the common mistakes in a literal — an empty uid, or one
holding a space, a `*`, a dot or a slash — and nothing more:

```ts
// @ts-expect-error: a * would widen a tenant token
defineIndex<Movie>()({ uid: '*', primaryKey: 'id' });
// @ts-expect-error: a dot
defineIndex<Movie>()({ uid: 'movies.v2', primaryKey: 'id' });
```

A unicode lookalike or a 401st character compiles, as does every uid typed
`string` or a union of literals; those are refused at run time only. A full
check in the types would walk the uid character by character, for a
refusal the run time already gives at the first call.

**395, to rebuild.** [`rebuild`](rebuild.md) fills `<uid>_next`, five
characters longer: a uid of 396 to 400 characters is valid, but its default
next uid is not, and `rebuild` throws a `TypeError` before sending anything.
Keep uids to 395, or pass a shorter `nextUid`.

`bindIndex` checks the uid again with the same rule, for a definition that
did not come from `defineIndex`.

## Why the empty `()`

TypeScript infers all of a call's type arguments or none.
`defineIndex<Movie>({ … })` would fix `Doc` and infer nothing else, so
`sortableAttributes: ['year', 'rating']` would widen to `string[]` — and a
search could then sort on anything. The first call takes the document type;
the second infers the settings and keeps their literal types.

```ts
movies.settings.sortableAttributes; // readonly ['year', 'rating'], not string[]
```

That is what makes `search(…, { sort: ['year:desc'] })` compile and
`sort: ['title:desc']` fail.

## What an attribute is

An attribute is a key of the document, or a dot path into it — arrays of
objects included, since Meilisearch flattens them — up to four levels:

```ts
interface Review { author: { name: string }; score: number }
interface Book { id: string; title: string; reviews: Review[] }

export const books = defineIndex<Book>()({
	uid: 'books',
	primaryKey: 'id',
	settings: {
		searchableAttributes: ['title', 'reviews.author.name'],
		filterableAttributes: ['reviews.score'],
	},
});
```

A path past four levels, and the keys of an index signature
(`Record<string, unknown>` accepts anything), are not checked.

## The primary key

`primaryKey` only accepts the keys whose value is a `string` or a `number` —
the two types Meilisearch takes as a document id. It also types every id you
pass later: `index.get(1)` for `id: number`, `index.get('abc')` for a string.

```ts
// @ts-expect-error: `director` is an object, not a string or a number
defineIndex<Movie>()({ uid: 'movies', primaryKey: 'director' });
```

A primary key cannot be changed once the index holds documents — `sync`
throws rather than delete anything. See
[guide/errors.md](errors.md#primary_key_mismatch).

## The settings

Each setting is optional, and **a setting the definition leaves out is not
managed**: `sync` neither compares it nor resets it. To own one, name it,
with its default if that is what you want (`stopWords: []`).

| Setting | Takes |
| --- | --- |
| `searchableAttributes` | attributes, or `'*'`; **in order of importance** |
| `displayedAttributes` | attributes, or `'*'` |
| `filterableAttributes` | attributes, or granular entries (below) |
| `sortableAttributes` | attributes |
| `distinctAttribute` | one attribute, or `null` |
| `rankingRules` | the built-in rules, or `'<attribute>:asc'` / `'<attribute>:desc'`; in order |
| `synonyms` | `Record<string, readonly string[]>` |
| `stopWords`, `separatorTokens`, `nonSeparatorTokens`, `dictionary` | strings |
| `typoTolerance` | `enabled`, `disableOnAttributes`, `disableOnWords`, `disableOnNumbers`, `minWordSizeForTypos` |
| `faceting` | `maxValuesPerFacet`, `sortFacetValuesBy` |
| `pagination` | `maxTotalHits` |
| `localizedAttributes` | `{ attributePatterns, locales }[]`, or `null` |
| `proximityPrecision`, `searchCutoffMs`, `facetSearch`, `prefixSearch` | as the SDK types them |
| `embedders` | the SDK's `Embedders`, unchanged |

`rankingRules` is the one to get right, since it decides the order of the
hits, and a custom rule must name a sortable attribute:

```ts
export const ranked = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		sortableAttributes: ['year', 'rating'],
		rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'rating:desc'],
	},
});
```

`filterableAttributes` also takes a granular entry, which turns single
features on or off, and whose patterns may hold a `*`:

```ts
export const granular = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		filterableAttributes: [
			'genres',
			{
				attributePatterns: ['director.*'],
				features: { facetSearch: false, filter: { equality: true, comparison: false } },
			},
		],
	},
});
```

A wildcard pattern is accepted as written and checked against nothing — and
it names no attribute, so `facets: ['director.country']` does not compile
from that entry alone.

`localizedAttributes` says which attributes are in which languages, as ISO
639-3 codes:

```ts
export const localized = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		localizedAttributes: [
			{ attributePatterns: ['title', 'overview'], locales: ['fra', 'eng'] },
		],
	},
});
```

## What the definition gives back

Six type helpers read a definition, for a function of your own that takes one:

```ts
import type {
	DocumentOf, FilterableOf, IdOf, PrimaryKeyNameOf, SearchableOf, SortableOf,
} from '@nxgt/meilisearch';

type Doc = DocumentOf<typeof movies>;        // Movie
type Key = PrimaryKeyNameOf<typeof movies>;  // 'id'
type Id = IdOf<typeof movies>;               // number
type Sortable = SortableOf<typeof movies>;   // 'year' | 'rating'
type Filterable = FilterableOf<typeof movies>; // 'genres' | 'year' (patterns left out)
type Searchable = SearchableOf<typeof movies>; // 'title' | 'overview' | 'director.name'
```

```ts
import type { AnyIndexDefinition, DocumentOf } from '@nxgt/meilisearch';

/** Anything that turns a row of your database into a document of that index. */
type Transform<Def extends AnyIndexDefinition, Row> = (row: Row) => DocumentOf<Def>;
```

`SearchableOf` is every attribute of the document when `searchableAttributes`
is `['*']` or absent, which is what Meilisearch does.

## Signatures

```ts
function defineIndex<Doc extends object>(): <const Config extends IndexConfig<Doc>>(
	config: Config,
) => IndexDefinition<Doc, Config>;

interface IndexConfig<Doc> {
	/** 1 to 400 ASCII letters, digits, - and _; anything else throws a TypeError. */
	uid: string;
	/** The attribute that identifies a document; it types every id. */
	primaryKey: PrimaryKeyOf<Doc>;
	settings?: IndexSettings<Doc>;
}

/** The keys of `Doc` whose value is a string or a number. */
type PrimaryKeyOf<Doc>;
/** The keys of `T`, and the dot paths into it, four levels deep. */
type DocumentPath<T>;
/** A pattern with a wildcard: `meta.*`, `*_at`. */
type AttributePattern = `${string}*${string}`;
```

An unknown key, in the config or in `settings`, does not compile either: a
misspelt setting name is caught where it is written, not on the server.

Next: [guide/sync.md](sync.md).

# @nxgt/meilisearch

A typed [Meilisearch](https://www.meilisearch.com) index, on the official
[`meilisearch`](https://www.npmjs.com/package/meilisearch) SDK: one
definition for its uid, its primary key and its settings; settings applied
idempotently at startup; documents and searches typed by it.

```ts
const movies = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: { filterableAttributes: ['genres'], sortableAttributes: ['year'] },
});

const movieIndex = bindIndex(client, movies);
await movieIndex.sync(); // creates the index, updates only the settings that differ

await movieIndex.add([alien, heat], { wait: true });
const { hits } = await movieIndex.search('alien', { sort: ['year:desc'], facets: ['genres'] });
// hits: Movie[]; sort takes only 'year:asc' | 'year:desc'; facets only 'genres'
```

Every attribute list of the settings takes only the document's attributes,
dot paths included. The ids are the primary key's type, a write takes a
whole `Movie` and an update a partial one with its id, and `sort`, `facets`
and `distinct` take only what the definition made sortable or filterable.

> **0.x, on meilisearch-js 0.62 and Meilisearch 1.x.** The API is still settling.

## Install

```sh
bun add @nxgt/meilisearch meilisearch
```

- `meilisearch` `>=0.62.0 <1`: required peer, the official SDK. You create
  its client; this package never creates one.
- `typescript` 6: required peer, the version every `@nxgt` package pins.
- A Meilisearch server, 1.x. Tested against 1.53.

## Setup

Define each index once, next to its document type:

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
		filterableAttributes: ['genres', 'year', 'director.name'],
		sortableAttributes: ['year', 'rating'],
		rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'rating:desc'],
		synonyms: { scifi: ['science fiction'] },
		typoTolerance: { minWordSizeForTypos: { oneTypo: 4 } },
		faceting: { sortFacetValuesBy: { genres: 'count' } },
		pagination: { maxTotalHits: 500 },
	},
});
```

Then, where the app starts, bring the server in line with the definitions:

```ts
import { Meilisearch } from 'meilisearch';
import { bindIndex, syncIndexes } from '@nxgt/meilisearch';

export const client = new Meilisearch({ host: process.env.MEILI_HOST!, apiKey: process.env.MEILI_KEY });

await syncIndexes(client, [movies, books]);

export const movieIndex = bindIndex(client, movies);
```

## Definition

`defineIndex<Doc>()({ uid, primaryKey, settings })` returns its config,
frozen, with the literal types of every setting kept: `sortableAttributes:
['year', 'rating']` stays `readonly ['year', 'rating']`, not `string[]`. That
is what types the searches of the index.

**Why the extra `()`.** TypeScript infers all of a call's type arguments or
none. `defineIndex<Movie>({ … })` would fix `Doc` and infer nothing else, and
the settings would widen to `string[]`. The first call takes the document
type; the second infers the settings.

What each setting takes:

| Setting | Type |
| --- | --- |
| `searchableAttributes`, `displayedAttributes` | attributes of the document, or `'*'`; in order |
| `filterableAttributes` | attributes, or granular entries: `{ attributePatterns, features }`, whose patterns may hold a `*` |
| `sortableAttributes` | attributes |
| `distinctAttribute` | an attribute, or `null` |
| `rankingRules` | the built-in rules, or `'<attribute>:asc'` / `'<attribute>:desc'` |
| `typoTolerance` | `enabled`, `disableOnAttributes` (attributes), `disableOnWords`, `disableOnNumbers`, `minWordSizeForTypos` |
| `faceting` | `maxValuesPerFacet`, `sortFacetValuesBy` (attributes or `'*'` to `'alpha'` / `'count'`) |
| `localizedAttributes` | `{ attributePatterns, locales }[]`, patterns as attributes or with a `*` |
| `synonyms`, `stopWords`, `separatorTokens`, `nonSeparatorTokens`, `dictionary` | strings |
| `pagination`, `proximityPrecision`, `searchCutoffMs`, `facetSearch`, `prefixSearch` | as the SDK types them |
| `embedders` | the SDK's `Embedders`, unchanged |

An attribute is a key of the document or a dot path into it, arrays of
objects included: `director.name`, `reviews.score`, four levels deep. A
misspelt attribute, a misspelt setting name, or a primary key that is not a
string or number attribute does not compile.

## Sync

```ts
const report = await movieIndex.sync();
// { uid: 'movies', created: true, primaryKeySet: false, changed: ['sortableAttributes', …], update: { … }, tasks: [ … ], dryRun: false }
```

`sync` (or `syncIndex(client, definition)`):

1. creates the index when it is missing, with its primary key;
2. gives the definition's primary key to an index that has none yet, and
   throws a `SearchIndexError` (`PRIMARY_KEY_MISMATCH`) for one that has
   another;
3. reads the live settings, compares them with the definition, and sends
   the settings that differ, and only those, in one `updateSettings`;
4. waits for every task it sent, and throws `SearchIndexError`
   (`TASK_FAILED`) if one fails.

Run it twice in a row and the second run sends no task: `changed` is `[]`,
`tasks` is `[]`.

The comparison follows what Meilisearch reads back. `searchableAttributes`,
`displayedAttributes` and `rankingRules` are compared in order; the other
lists as sets, since Meilisearch stores `sortableAttributes` and `stopWords`
sorted. `typoTolerance`, `faceting`, `pagination` and `embedders` match when
the fields the definition sets have its values: Meilisearch fills the rest
with defaults.

`syncIndexes(client, definitions)` syncs each in order and returns their
reports; the first that throws stops the rest.

A dry run compares and reports, and sends nothing:

```ts
const [report] = await syncIndexes(client, [movies], { dryRun: true });
if (report.created || report.changed.length > 0) process.exitCode = 1; // a CI check
```

`wait: { timeout, interval }` is passed to the SDK for each task:

```ts
await movieIndex.sync({ wait: { timeout: 120_000 } });
```

## Documents

### Writing

```ts
await movieIndex.add(movies); // adds, or replaces those whose id exists
await movieIndex.update([{ id: 1, rating: 9 }]); // merges into document 1
await movieIndex.delete(1);
await movieIndex.delete([2, 3]);
await movieIndex.deleteAll(); // keeps the index and its settings

await movieIndex.addInBatches(thousands, { batchSize: 500 }); // one task per 500
await movieIndex.updateInBatches(patches, { batchSize: 500 });
```

**Waiting.** A write returns what the SDK returns: an `EnqueuedTaskPromise`,
which resolves once Meilisearch has queued the task, and whose `waitTask()`
waits for it. Pass `wait` and the write resolves to the finished `Task`
instead, and throws a `SearchIndexError` (`TASK_FAILED`) when the task
failed:

```ts
const enqueued = await movieIndex.add(docs); // { taskUid, status: 'enqueued', … }
const task = await movieIndex.add(docs, { wait: true }); // Task, status 'succeeded'
await movieIndex.delete(1, { wait: { timeout: 10_000 } });
```

The return type follows the option: `Promise<Task>` with `wait`, the SDK's
`EnqueuedTaskPromise` without. The batch methods return one of either per
batch. `customMetadata` is passed to the task.

Every write names the definition's primary key, so an index a write creates
before any `sync` gets that key, not one Meilisearch guesses.

### Reading

```ts
await movieIndex.get(1); // Movie | undefined
await movieIndex.get(1, { fields: ['title', 'year'] }); // Pick<Movie, 'title' | 'year'> | undefined
await movieIndex.getMany([1, 2, 3]); // Movie[], without the missing ids
await movieIndex.list({ filter: 'genres = scifi', sort: ['year:desc'], limit: 20, offset: 40 });
// { results: Movie[], total, offset, limit }
```

`get` resolves `undefined` for an id with no document; any other error is
the SDK's. `list` filters and sorts only on filterable and sortable
attributes, as Meilisearch requires.

## Search

```ts
const result = await movieIndex.search('ridley', {
	filter: ['genres = scifi', 'year > 1980'],
	sort: ['rating:desc'],
	facets: ['genres', 'director.name'],
	attributesToHighlight: ['title'],
	limit: 20,
});
result.hits; // Hit<Movie>[]: the document, with _formatted, _rankingScore…
result.facetDistribution; // { genres: { scifi: 2, … } }
result.estimatedTotalHits;
```

The options are the SDK's `SearchParams`, with these typed by the definition:

| Option | Takes |
| --- | --- |
| `sort` | `'<sortable>:asc'` / `'<sortable>:desc'`, and `'_geoPoint(lat, lng):asc'` when `_geo` is sortable |
| `facets` | filterable attributes, or `'*'` |
| `distinct` | a filterable attribute |
| `attributesToSearchOn` | the `searchableAttributes`, or any attribute when it is `['*']` or unset |
| `attributesToRetrieve`, `attributesToHighlight`, `attributesToCrop` | attributes of the document, or `'*'` |

`filter` stays the SDK's string or array of strings: this package has no
filter builder.

`page` or `hitsPerPage` switch the response to numbered pages, in the types
too: `totalHits`, `totalPages`, `page` and `hitsPerPage` instead of
`estimatedTotalHits`, `offset` and `limit`.

```ts
const page = await movieIndex.search('', { page: 2, hitsPerPage: 20 });
page.totalPages; // number
```

For anything else (`searchForFacetValues`, `searchSimilarDocuments`, stats,
a single setting), `movieIndex.raw` is the SDK's own `Index`.

## Errors

The SDK's errors reach you as they are: a request Meilisearch refuses throws
its `MeilisearchApiError`, with `cause.code`, a timeout its
`MeilisearchTaskTimeOutError`.

This package throws one error of its own, `SearchIndexError`:

| `code` | When | Carries |
| --- | --- | --- |
| `PRIMARY_KEY_MISMATCH` | `sync` found the index with another primary key | `expectedPrimaryKey`, `actualPrimaryKey` |
| `TASK_FAILED` | a task this package waited for ended `failed` or `canceled` | `task`, and `cause`: the task's `error` |

```ts
import { SearchIndexError } from '@nxgt/meilisearch';

try {
	await movieIndex.add(docs, { wait: true });
} catch (error) {
	if (error instanceof SearchIndexError && error.code === 'TASK_FAILED') {
		console.error(error.task?.error?.code); // 'invalid_document_id'
	}
	throw error;
}
```

## Not included

- **A typed filter builder.** `filter` is the SDK's string or array.
- **A tasks or errors layer.** Tasks and errors are the SDK's; the only error
  added is `SearchIndexError`.
- **Syncing documents from a database**, with `@nxgt/drizzle` or anything
  else. Write the documents with `add` or `update` where your data changes.

## API

### `defineIndex<Doc>()(config)`

```ts
function defineIndex<Doc extends object>(): <const Config extends IndexConfig<Doc>>(
	config: Config,
) => IndexDefinition<Doc, Config>;
```

- `interface IndexConfig<Doc> { uid: string; primaryKey: PrimaryKeyOf<Doc>; settings?: IndexSettings<Doc> }`.
- `interface IndexSettings<Doc>`: the settings in the [table above](#definition), each optional.
- `type IndexDefinition<Doc, Config>`: the config, read-only, carrying `Doc`. `type AnyIndexDefinition` is any of them.
- `type DocumentPath<T>`: the keys of `T` and the dot paths into it, four levels deep.
- `type AttributePattern = `${string}*${string}``: a wildcard pattern.
- `type PrimaryKeyOf<Doc>`: the keys whose value is a `string` or a `number`.
- `type RankingRule<Path>`, `interface GranularFilterableAttribute<Path>`, `interface LocalizedAttribute<Path>`.
- What a definition gives: `DocumentOf<Def>`, `PrimaryKeyNameOf<Def>`, `IdOf<Def>`, `SortableOf<Def>`, `FilterableOf<Def>` (patterns left out) and `SearchableOf<Def>`.

### `syncIndex(client, definition, options?)` and `syncIndexes(client, definitions, options?)`

```ts
function syncIndex(client: Meilisearch, definition: AnyIndexDefinition, options?: SyncOptions): Promise<SyncReport>;
function syncIndexes(client: Meilisearch, definitions: readonly AnyIndexDefinition[], options?: SyncOptions): Promise<SyncReport[]>;
```

- `interface SyncOptions { dryRun?: boolean; wait?: WaitOptions }`.
- `interface SyncReport { uid: string; created: boolean; primaryKeySet: boolean; changed: (keyof Settings)[]; update: Settings; tasks: Task[]; dryRun: boolean }`.
- `diffSettings(wanted: Settings, live: Settings): Settings`: the settings of `wanted` that `live` does not match, compared as `sync` does.

### `bindIndex(client, definition)`

```ts
function bindIndex<Def extends AnyIndexDefinition>(client: Meilisearch, definition: Def): TypedIndex<Def>;
```

Sends nothing. `TypedIndex<Def>`, where `Doc` is `DocumentOf<Def>` and `Id`
is `IdOf<Def>`:

| Member | |
| --- | --- |
| `uid`, `definition`, `client` | what it was bound with |
| `raw: Index<Doc>` | the SDK's index |
| `sync(options?: SyncOptions): Promise<SyncReport>` | `syncIndex` for this definition |
| `add(documents: readonly Doc[], options?: WriteOptions): WriteResult` | adds or replaces |
| `update(documents: readonly DocumentPatch<Def>[], options?: WriteOptions): WriteResult` | merges; each needs its id |
| `addInBatches(documents, options?: BatchWriteOptions): BatchWriteResult` | `batchSize`, 1000 by default |
| `updateInBatches(documents, options?: BatchWriteOptions): BatchWriteResult` | |
| `delete(ids: Id \| readonly Id[], options?: WriteOptions): WriteResult` | |
| `deleteAll(options?: WriteOptions): WriteResult` | |
| `get(id: Id, options?: { fields? }): Promise<Doc \| undefined>` | `Pick<Doc, …>` with `fields` |
| `getMany(ids: readonly Id[], options?: { fields? }): Promise<Doc[]>` | |
| `list(query?: ListQuery<Def>): Promise<DocumentPage<Doc>>` | `filter`, `sort`, `fields`, `limit`, `offset` |
| `search(query?: string \| null, options?: SearchOptions<Def>): Promise<SearchResult<Def, Options>>` | |

The types it uses:

- `interface WriteOptions { wait?: boolean | WaitOptions; customMetadata?: string }`; `interface BatchWriteOptions extends WriteOptions { batchSize?: number }`.
- `type WriteResult<Options>`: `Promise<Task>` when `Options` has `wait`, else `EnqueuedTaskPromise`. `type BatchWriteResult<Options>`: the same, one per batch.
- `type DocumentPatch<Def> = Partial<Doc> & Pick<Doc, PrimaryKeyNameOf<Def>>`.
- `interface SearchOptions<Def>`: the SDK's `SearchParams`, with `sort`, `facets`, `distinct`, `attributesToRetrieve`, `attributesToHighlight`, `attributesToCrop` and `attributesToSearchOn` typed.
- `type SearchResult<Def, Options>`: the SDK's `SearchResponse<Doc, …>`.
- `type SortExpression<Def>`, `type AttributeOrWildcard<Def>`, `type OrderDirection = 'asc' | 'desc'`.
- `interface ListQuery<Def, Fields>`, `interface DocumentPage<T> { results: T[]; total: number; offset: number; limit: number }`.
- `type FieldOf<Def>`, `type Selected<Doc, Fields>`, `interface FieldsOptions<Fields>`.

### `SearchIndexError`

- `class SearchIndexError extends Error`: `code: SearchIndexErrorCode`, `indexUid: string`, `task: Task | undefined`, `expectedPrimaryKey: string | undefined`, `actualPrimaryKey: string | undefined`, `cause`.
- `type SearchIndexErrorCode = 'PRIMARY_KEY_MISMATCH' | 'TASK_FAILED'`.

## Traps

- **A setting the definition leaves out is not managed.** `sync` neither
  compares nor resets it: a stop word added from the dashboard stays. To own
  a setting, name it, with its default if that is what you want
  (`stopWords: []`).
- **The SDK waits 5 seconds for a task.** A settings change on an index with
  many documents re-indexes it, and takes longer: the wait then throws the
  SDK's `MeilisearchTaskTimeOutError`, while the task goes on in Meilisearch.
  Pass `sync({ wait: { timeout: 120_000 } })`, or `defaultWaitOptions` to
  the client.
- **Without `wait`, a write is only queued.** A search right after it may
  not see the documents yet. And the SDK resolves a failed task like a
  succeeded one: `await enqueued.waitTask()` gives a `Task` whose `status`
  can be `'failed'`. With `wait`, this package throws instead.
- **A primary key cannot change once the index holds documents.** `sync`
  throws `PRIMARY_KEY_MISMATCH` rather than delete anything. Delete the
  index yourself, sync, and add the documents again.
- **Options in a variable lose their literals.** `const options = { sort:
  ['year:desc'] }` is a `string[]`, which `search` refuses. Write it inline,
  or `satisfies SearchOptions<typeof movies>`.
- **`attributesToRetrieve`, `displayedAttributes` and `fields` in a search
  do not narrow the hits.** A hit is typed as the whole document, even when
  Meilisearch returns part of it. `get`, `getMany` and `list` do narrow to
  their `fields`.
- **`getMany` returns documents in Meilisearch's order**, not in the order
  of the ids.
- **An embedder's `apiKey` is not compared.** Meilisearch reads it back
  masked, so `sync` skips it: a new key alone is not sent. Change it with
  `movieIndex.raw.updateEmbedders`.
- **Wildcard patterns are not checked.** `meta.*` in `filterableAttributes`
  is accepted as a pattern, and names no attribute for `facets` or
  `distinct`. Neither are dot paths past four levels, nor the keys of an
  index signature: `Record<string, …>` accepts any path.
- **`sync` needs a key that may create indexes and change settings**:
  `indexes.create`, `indexes.get`, `indexes.update`, `settings.get`,
  `settings.update` and `tasks.get`. A search-only key is enough for the
  rest.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/definition.md](docs/guide/definition.md) — `defineIndex`, the settings, and the types a definition gives back.
- [docs/guide/sync.md](docs/guide/sync.md) — `syncIndex`, the report, dry runs, and how the settings are compared.
- [docs/guide/documents.md](docs/guide/documents.md) — `bindIndex`, writes, waiting for a task, reads by id, `list`.
- [docs/guide/search.md](docs/guide/search.md) — filters, sorts, facets, highlighting and the two paginations.
- [docs/guide/errors.md](docs/guide/errors.md) — `SearchIndexError`, the SDK's errors, one handler for the app.
- [docs/troubleshooting.md](docs/troubleshooting.md) — an error message, and its fix.
- [docs/roadmap.md](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT

# Documents

`bindIndex` ties a [definition](definition.md) to a client: one object whose
writes take your document type and whose ids are the primary key's type.

```ts
import { Meilisearch } from 'meilisearch';
import { bindIndex } from '@nxgt/meilisearch';
import { movies } from './indexes';

const client = new Meilisearch({ host: process.env.MEILI_HOST! });
const movieIndex = bindIndex(client, movies);

await movieIndex.sync(); // the index and its settings: see guide/sync.md
await movieIndex.add([alien, bladeRunner], { wait: true });

const alienAgain = await movieIndex.get(1); // Movie | undefined
```

`bindIndex` sends nothing by itself. `movieIndex.raw` is the SDK's own
`Index`, for anything this one does not wrap.

## Writing

```ts
await movieIndex.add([alien, heat]);            // adds, or replaces by id
await movieIndex.update([{ id: 1, rating: 9 }]); // merges into document 1
await movieIndex.delete(1);
await movieIndex.delete([2, 3]);
await movieIndex.deleteAll();                    // keeps the index and its settings
```

`add` replaces a document whole; `update` merges the attributes given into
the one with that id, and adds it when there is none. A patch is
`Partial<Movie>` **with its id**:

```ts
await movieIndex.update([{ id: 1, rating: 9 }]);
// @ts-expect-error: a patch without the primary key
await movieIndex.update([{ rating: 9 }]);
```

Large imports go in batches — one task per batch, so Meilisearch is not sent
a single enormous request:

```ts
await movieIndex.addInBatches(everyMovie, { batchSize: 1000, wait: true });
await movieIndex.updateInBatches(patches, { batchSize: 500 });
```

Every write names the definition's primary key, so an index that a write
creates *before* any `sync` gets that key rather than one Meilisearch
guesses from the first document.

## Waiting, or not

A write is a task. Without `wait`, it resolves as soon as Meilisearch has
queued it; with `wait`, it resolves once the task succeeded, and throws
[`SearchIndexError`](errors.md#task_failed) when it failed.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `wait` | `boolean \| { timeout?: number; interval?: number }` | none | wait for the task, and resolve to it; `true` uses the client's wait options |
| `customMetadata` | `string` | none | stored on the task, and read back on it |
| `batchSize` | `number` | the SDK's `1000` | `addInBatches` and `updateInBatches` only: documents per task |

```ts
const enqueued = movieIndex.add(docs); // an EnqueuedTaskPromise: do not await it yet
const { taskUid, status } = await enqueued; // number, 'enqueued'
await enqueued.waitTask(); // the SDK's own wait: a failed task resolves, it does not throw

const task = await movieIndex.add(docs, { wait: true });
task.status; // 'succeeded' — or a SearchIndexError was thrown
task.details?.indexedDocuments; // 2

await movieIndex.delete(1, { wait: { timeout: 10_000 } });
await movieIndex.add(docs, { wait: true, customMetadata: 'nightly-import' });
```

The return type follows the option, so there is no cast either way:

```ts
// WriteResult<Options>:      Promise<Task> with `wait`, else the SDK's EnqueuedTaskPromise
// BatchWriteResult<Options>: the same, one per batch — Promise<Task[]> or EnqueuedTaskPromise[]
```

```ts
const tasks = await movieIndex.addInBatches(docs, { batchSize: 3, wait: true }); // Task[]
const queued = movieIndex.addInBatches(docs, { batchSize: 3 });                  // EnqueuedTaskPromise[]
await Promise.all(queued.map((task) => task.waitTask()));
```

**Without `wait`, a search right after a write may not see the documents
yet.** That is Meilisearch's own asynchrony, not a delay this package adds.

## Reading by id

```ts
await movieIndex.get(1);                          // Movie | undefined
await movieIndex.get(1, { fields: ['title', 'year'] }); // Pick<Movie, 'title' | 'year'> | undefined
await movieIndex.getMany([1, 2, 3]);              // Movie[], missing ids left out
await movieIndex.getMany([]);                     // [], no request sent
```

`get` resolves `undefined` for a document that is not there — and only for
that. A missing *index* is still the SDK's `MeilisearchApiError`, with
`cause.code === 'index_not_found'`: a configuration fault, not an empty
result.

`fields` narrows the result type as well as the response, and takes
top-level attributes. `getMany` returns the documents in Meilisearch's
order, not in the order of the ids.

## Listing

`list` is the documents endpoint: a filtered, sorted page, without a search
query.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `filter` | the SDK's `Filter` (a string, or an array) | none | only on filterable attributes |
| `sort` | `readonly '<sortable>:asc' \| '<sortable>:desc'[]` | none | only on sortable attributes |
| `fields` | `readonly (keyof Doc)[]` | every attribute | narrows the returned type |
| `limit`, `offset` | `number` | the server's | |

```ts
const page = await movieIndex.list({
	filter: 'genres = scifi',
	sort: ['year:desc'],
	limit: 20,
	offset: 40,
	fields: ['id', 'title'],
});
// { results: Pick<Movie, 'id' | 'title'>[], total: 3, offset: 40, limit: 20 }
```

```ts
interface DocumentPage<T> { results: T[]; total: number; offset: number; limit: number }
```

`total` is the number of documents the filter matches, not the page's
length — use it for a page count. For relevance, ranking and facets, use
[search](search.md) instead.

## Indexing what your database holds

The documents are written where the data changes: the write to Meilisearch
sits next to the write to the database.

```ts
import type { DocumentOf } from '@nxgt/meilisearch';
import { movies } from './indexes';
import { movieIndex } from './search';

type MovieDocument = DocumentOf<typeof movies>;

function toDocument(row: MovieRow): MovieDocument {
	return {
		id: row.id,
		title: row.title,
		overview: row.overview ?? '',
		year: row.releasedAt.getFullYear(),
		rating: row.rating,
		genres: row.genres,
		director: { name: row.directorName, country: row.directorCountry },
	};
}

export async function saveMovie(row: MovieRow) {
	await db.movies.save(row);
	await movieIndex.add([toDocument(row)]); // queued; the request does not wait
}

/** A full reindex, from a cursor over the table. */
export async function reindexMovies(rows: AsyncIterable<MovieRow>) {
	const batch: MovieDocument[] = [];
	for await (const row of rows) {
		batch.push(toDocument(row));
		if (batch.length === 1000) {
			await movieIndex.add(batch.splice(0), { wait: true });
		}
	}
	if (batch.length > 0) await movieIndex.add(batch, { wait: true });
}
```

A delete leaves no trace to follow, so delete from the index in the same
place: `await movieIndex.delete(row.id)`.

## Signatures

```ts
function bindIndex<Def extends AnyIndexDefinition>(
	client: Meilisearch,
	definition: Def,
): TypedIndex<Def>;

interface TypedIndex<Def> {
	readonly uid: string;
	readonly definition: Def;
	readonly client: Meilisearch;
	/** The SDK's own index, for anything this one does not wrap. */
	readonly raw: Index<DocumentOf<Def> & RecordAny>;

	sync(options?: SyncOptions): Promise<SyncReport>;

	add<O extends WriteOptions>(documents: readonly DocumentOf<Def>[], options?: O): WriteResult<O>;
	addInBatches<O extends BatchWriteOptions>(documents: readonly DocumentOf<Def>[], options?: O): BatchWriteResult<O>;
	update<O extends WriteOptions>(documents: readonly DocumentPatch<Def>[], options?: O): WriteResult<O>;
	updateInBatches<O extends BatchWriteOptions>(documents: readonly DocumentPatch<Def>[], options?: O): BatchWriteResult<O>;
	delete<O extends WriteOptions>(ids: IdOf<Def> | readonly IdOf<Def>[], options?: O): WriteResult<O>;
	deleteAll<O extends WriteOptions>(options?: O): WriteResult<O>;

	get<F extends FieldOf<Def>>(id: IdOf<Def>, options?: FieldsOptions<F>): Promise<Selected<DocumentOf<Def>, F> | undefined>;
	getMany<F extends FieldOf<Def>>(ids: readonly IdOf<Def>[], options?: FieldsOptions<F>): Promise<Selected<DocumentOf<Def>, F>[]>;
	list<F extends FieldOf<Def>>(query?: ListQuery<Def, F>): Promise<DocumentPage<Selected<DocumentOf<Def>, F>>>;

	search<O extends SearchOptions<Def>>(query?: string | null, options?: O): Promise<SearchResult<Def, O>>;
}

type DocumentPatch<Def> = Partial<DocumentOf<Def>> & Pick<DocumentOf<Def>, PrimaryKeyNameOf<Def>>;
```

Next: [guide/search.md](search.md).

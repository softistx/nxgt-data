# @nxgt/drizzle-meilisearch

Keeps a [Meilisearch](https://www.meilisearch.com) index in step with a
PostgreSQL table: a typed transform from a Drizzle row to a document, a full
reindex, and one call per write.

```ts
import { createSearchSync } from '@nxgt/drizzle-meilisearch';

const articleRepository = createRepository(db, articles); // @nxgt/drizzle

const articleSearch = createSearchSync({
	repository: articleRepository,
	index: bindIndex(meili, articleIndex),        // @nxgt/meilisearch
	toIndexId: (article) => article.id,
	transform: (article) =>
		article.draft ? null : { id: article.id, title: article.title },
});

const article = await articleRepository.create({ title: 'Hello' });
await articleSearch.indexRow(article); // and one call per write after that
```

`transform` takes the table's row, typed by the table, and gives the index's
document, typed by its definition; `null` keeps a row out of the index, and
takes it out if it was in. `reindexAll()` fills the index from the table, and
removes from it whatever the table no longer gives.

**There is no `start()`, no resume point and no change following:** PostgreSQL
offers nothing like MongoDB's change stream that this package could follow, so
it removes the collage around a write — the transform, the id, the batching,
the delete of a row that stopped qualifying — and not the decision of when to
index. [The roadmap](docs/roadmap.md) says why.

> **0.x, on `@nxgt/drizzle` and `@nxgt/meilisearch`.** The API is still settling.

## Install

```sh
bun add @nxgt/drizzle-meilisearch @nxgt/drizzle @nxgt/meilisearch drizzle-orm@rc meilisearch typescript
```

- `@nxgt/drizzle` and `@nxgt/meilisearch`: required peers. The repository and
  the index are theirs, and so are their options; this package creates
  neither.
- `drizzle-orm` `>=1.0.0-rc.4 <2` and `meilisearch` `>=0.62.0 <1`: required
  peers, as the two packages above need them.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package
  pins.
- A PostgreSQL database, reached through any Drizzle driver, and a
  Meilisearch server, 1.x. Tested against Meilisearch 1.53.

## Setup

The table is `@nxgt/drizzle`'s and the index is `@nxgt/meilisearch`'s; this
package defines neither:

```ts
import { id, softDelete, timestamps } from '@nxgt/drizzle/pg';
import { defineIndex } from '@nxgt/meilisearch';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';

export const articles = pgTable('articles', {
	id: id(),
	title: text('title').notNull(),
	draft: boolean('draft').notNull().default(false),
	...timestamps(),
	...softDelete(),
});

export interface ArticleHit {
	id: string;
	title: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title'] },
});
```

Then, where the app starts:

```ts
import { createRepository } from '@nxgt/drizzle/pg';
import { bindIndex } from '@nxgt/meilisearch';
import { createSearchSync } from '@nxgt/drizzle-meilisearch';

export const articleRepository = createRepository(db, articles);
export const index = bindIndex(meili, articleIndex);
await index.sync(); // the index's settings are @nxgt/meilisearch's to apply

export const articleSearch = createSearchSync({
	repository: articleRepository,
	index,
	toIndexId: (article) => article.id,
	transform: (article) =>
		article.draft ? null : { id: article.id, title: article.title },
});
```

`createSearchSync` sends nothing and opens nothing: it checks its options and
gives back an object. Every write comes from a method on it.

## Indexing after a write

One call beside the write the application already makes. The row a repository
hands back is what the index takes:

```ts
const article = await articleRepository.create({ title: 'Hello' });
await articleSearch.indexRow(article);

// The same call takes a row out when the transform stops wanting it.
const draft = await articleRepository.update(article.id, { draft: true });
await articleSearch.indexRow(draft); // transform gives null → removed

const rows = await articleRepository.createMany([{ title: 'a' }, { title: 'b' }]);
await articleSearch.indexRows(rows);
```

`indexRow`, `indexRows`, `removeRow`, `remove` and `removeMany` all take
`{ wait }`, `false` by default: Meilisearch indexes asynchronously, and a
request that has just written a row should not hold its response open for it.
`{ wait: true }` is what a script or a test wants.
[Indexing after a write](docs/guide/indexing-writes.md) has the rest.

## Taking a row out

```ts
const deleted = await articleRepository.delete(article.id); // soft delete
await articleSearch.removeRow(deleted); // reads the id with toIndexId

const gone = await articleRepository.hardDelete(article.id);
await articleSearch.removeRow(gone); // a hard delete hands the row back too

await articleSearch.remove(id); // when all you have is the index id
```

## Filling the index

```ts
const report = await articleSearch.reindexAll();
// { indexed: 1204, skipped: 17, removed: 3 }
```

Every live row through the transform, a page at a time, then out of the index
everything the table no longer gives it — rows that were deleted, rows the
transform turned away, documents that were never this table's.
`reindexAll` always waits for Meilisearch, because what it removes is decided
by reading the index back. [Reindexing](docs/guide/reindex.md) has the
details.

## Errors

Every failure of a write or a reindex is a `SearchSyncError`, with the sync's
`name` as `sync` and the original error as `cause`.

| `code` | When |
| --- | --- |
| `ID_MISMATCH` | the transform gave a document whose primary key is not that row's index id |
| `NOT_A_DOCUMENT` | the transform gave something that is neither a document nor `null`. The message says its shape, never its value |
| `FAILED` | anything else: the transform threw, PostgreSQL or Meilisearch refused. The message says what the sync was doing |

```ts
import { SearchSyncError } from '@nxgt/drizzle-meilisearch';

try {
	await articleSearch.indexRow(article, { wait: true });
} catch (error) {
	if (error instanceof SearchSyncError && error.code === 'FAILED') {
		log.error({ sync: error.sync, cause: error.cause });
	} else throw error;
}
```

An option out of range is a bare `TypeError`, not a `SearchSyncError`, and it
comes before anything is sent. `createSearchSync` throws one for a
`batchSize` or a `pageSize` that is not a whole number above zero, an empty
`name`, or a `transform` or `toIndexId` that is not a function; `reindexAll`
throws one for the `pageSize` given to the call, and names the sync it came
from:

```ts
createSearchSync({ …, batchSize: 0 });
// TypeError: createSearchSync: batchSize must be a whole number above 0, not 0

await articleSearch.reindexAll({ pageSize: -1 });
// TypeError: reindexAll on "articles:articles": pageSize must be a whole
// number above 0, not -1
```

## API

### `createSearchSync(options)`

```ts
function createSearchSync<TTable extends PgTable, I extends AnyIndexDefinition>(
	options: SearchSyncOptions<TTable, I>,
): SearchSync<TTable, I>;
```

`SearchSyncOptions<TTable, I>`:

| Option | Default | |
| --- | --- | --- |
| `repository: SyncRepository<TTable>` | | from `createRepository`, or one narrowed by `with(tx)`: the table and `paginateByCursor` are all this package reads |
| `index: TypedIndex<I>` | | from `bindIndex` |
| `transform: Transform<TTable, I>` | | `(row: Row<TTable>) => DocumentOf<I> \| null`, or a promise of it. `Row` is `@nxgt/drizzle`'s, `DocumentOf` `@nxgt/meilisearch`'s |
| `toIndexId: ToIndexId<TTable, I>` | | `(row: Row<TTable>) => IdOf<I>`. **Required** |
| `name: string` | `'<table>:<index uid>'` | what the errors carry as `sync` |
| `batchSize: number` | `500` | documents, or ids, per Meilisearch task |
| `pageSize: number` | `100` | rows `reindexAll` reads per page; above the repository's `maxPageSize`, lowered to it |

`SearchSync<TTable, I>`:

| Member | |
| --- | --- |
| `name: string` | |
| `reindexAll(options?: { pageSize?: number }): Promise<ReindexReport>` | `ReindexReport` is `{ indexed, skipped, removed }`, all `number`. Always waits |
| `indexRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>` | the transform decides: a document, or `null` to take the row out |
| `indexRows(rows: readonly Row<TTable>[], options?): Promise<void>` | deduplicated by index id, last one wins |
| `removeRow(row: Row<TTable>, options?): Promise<void>` | by the id `toIndexId` gives for the row |
| `remove(id: IdOf<I>, options?): Promise<void>` | by index id |
| `removeMany(ids: readonly IdOf<I>[], options?): Promise<void>` | |

`IndexWriteOptions` is `{ wait?: boolean }`, `false` by default.

`class SearchSyncError extends Error`: `code: SearchSyncErrorCode`
(`'ID_MISMATCH' | 'NOT_A_DOCUMENT' | 'FAILED'`), `sync: string`, and `cause`.
Its constructor takes `(message, options: SearchSyncErrorOptions)`, that is
`{ code, sync, cause? }`; both types are exported, along with
`SearchSyncOptions`, `SearchSync`, `SyncRepository`, `Transform`,
`ToIndexId`, `IndexWriteOptions` and `ReindexReport`.

[Wiring a sync](docs/guide/wiring.md) has each option with its snippet.

## What does not compile

Each is a `@ts-expect-error` case in this package's type tests.

- A transform that reads a column the table does not have, or that gives a
  field the index's document does not have — or leaves one out.
- A transform that gives something other than a document or `null`: a value,
  or a list of documents.
- No `transform`, and no `toIndexId`: neither has a default.
- A `toIndexId` that gives another type than the index's ids — a `Date` for a
  string id, a `string` for a number one — or that reads a column of another
  table.
- The table itself for `repository`, or the SDK's own `Index` for `index`.
- An option this package does not have, a `batchSize` that is not a number,
  or a `name` that is not a string.
- `remove(1)` on an index whose ids are strings, one row where `indexRows`
  takes a list, a row of another table, `{ waitFor: true }`, or a `wait` that
  is not a boolean.

## Traps

- **`toIndexId` is required**, where the MongoDB bridge defaults it to
  `String`. Drizzle 1.0's column types do not carry `.primaryKey()`, so
  nothing at the type level knows which column the id is: say it in one line
  per sync, `toIndexId: (row) => row.id`.
- **`wait` is `false` by default.** A write that returns has been enqueued,
  not applied; read the index back only with `{ wait: true }`.
- **A `pageSize` above the repository's `maxPageSize`** (100 by default) is
  silently lowered to it: asking for 1000 means ten times more pages, not
  bigger ones. Raise `maxPageSize` on the repository to page in larger reads.
- **A delete does not create an index.** Meilisearch creates one on a write
  of documents, never on a delete, so `remove(...)` with `{ wait: true }` on
  an index nothing has written to yet fails with ``Index `articles` not
  found``. Call `index.sync()` at startup, or reindex first.
- **The transform must give the row's index id** under the index's primary
  key: a document under another id could never be taken out again, and is
  refused with `ID_MISMATCH`.
- **`reindexAll` owns the index.** It removes every document the table does
  not give it, whoever wrote it, so do not point a second writer at the same
  index.
- **Index after the transaction commits.** A row indexed inside
  `withTransaction` and then rolled back stays in the index; Meilisearch
  takes no part in the transaction.

## What it does not do

- **No change following.** No `start()`, no resume point, no background
  worker: a row is indexed when the application says so.
- **No partial updates.** A write sends the whole document the transform
  gives, never a patch.
- **Keeping the index's settings** — that is `@nxgt/meilisearch`'s `sync()`.
- **Joining other tables into a document.** The transform may read them, but
  a write to them does not reach the index.

## Documentation

- [Guide index](docs/README.md) — every page, and when to read it.
- [Wiring a sync](docs/guide/wiring.md) — the repository, the index, the
  transform, and every option with its default.
- [Indexing after a write](docs/guide/indexing-writes.md) — the five write
  calls, `wait`, and batching.
- [Reindexing](docs/guide/reindex.md) — the full fill, and what it removes.
- [Troubleshooting](docs/troubleshooting.md) — the errors, by their message.
- [Roadmap](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT

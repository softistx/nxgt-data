# Indexing after a write

The index follows the table because the application says so: one call on the
sync beside each write it already makes. This page is the five calls that do
it, and the one option they share.

```ts
import { articleRepository, articleSearch } from './search/articles';

const article = await articleRepository.create({ title: 'Hello' });
await articleSearch.indexRow(article);
```

`indexRow` takes the row the repository handed back — no second read — runs
the transform on it, and sends the document under the id `toIndexId` gives.
The same call takes the row **out** when the transform now returns `null`.

## The five calls

| Call | Takes | For |
| --- | --- | --- |
| `indexRow(row, options?)` | one row | what `create`, `update` or `restore` gave back |
| `indexRows(rows, options?)` | rows | what `createMany`, `updateMany` or `findMany` gave back |
| `removeRow(row, options?)` | one row | what `delete` or `hardDelete` gave back: it reads the id with `toIndexId` |
| `remove(id, options?)` | one index id | you have an id and no row: an id from a request, a list from another query |
| `removeMany(ids, options?)` | index ids | several at once |

All five resolve to `void`, and all five take `{ wait }`.

```ts
// A create, then an update that turns the row into a draft: one call each.
const article = await articleRepository.create({ title: 'Hello' });
await articleSearch.indexRow(article);

const draft = await articleRepository.update(article.id, { draft: true });
await articleSearch.indexRow(draft); // transform gives null → taken out

const published = await articleRepository.update(article.id, { draft: false });
await articleSearch.indexRow(published); // back in, under the same id
```

A document sent again under an id the index already holds **replaces** it, so
an update is the same call as a create.

### Removing

```ts
// Soft delete: the row is still there, and still has its id.
const deleted = await articleRepository.delete(article.id);
await articleSearch.removeRow(deleted);

// Hard delete hands the row back too, so removeRow suits it as well.
const gone = await articleRepository.hardDelete(article.id);
await articleSearch.removeRow(gone);

// remove(id) is for when there is no row to read: an id from a request,
// ids from a query of your own.
await articleSearch.remove(id);
await articleSearch.removeMany(ids);

// deleteMany and hardDeleteMany hand back rows, and there is no removeRows:
// read the ids the same way removeRow would. `eq` is drizzle-orm's.
const removed = await articleRepository.deleteMany(eq(articles.draft, true));
await articleSearch.removeMany(removed.map((article) => article.id));
```

`removeRow` reads the id with `toIndexId` and sends it; `remove` takes the
index id as the index's own type. Which of the two you use is a matter of
what you are holding, not of how the row was deleted.

Removing an id the index does not hold is **not** an error: Meilisearch
ignores it.

A soft delete could also go through `indexRow`, when the transform returns
`null` for a row with a `deletedAt` — both take it out. `removeRow` says it
without running the transform.

### Nothing to do is nothing sent

```ts
await articleSearch.indexRows([]);  // no request
await articleSearch.removeMany([]); // no request
```

An empty list is not a round trip, which is what makes
`await articleSearch.indexRows(await repo.updateMany(where, patch))` safe when
nothing matched.

## `wait`

```ts
interface IndexWriteOptions {
	wait?: boolean; // default false
}
```

**`false` by default.** Meilisearch indexes asynchronously: a write returns as
soon as the task is enqueued, and the document shows up a moment later. A
request that has just written a row should not hold its response open for it.

```ts
await articleSearch.indexRow(article);              // enqueued, back at once
await articleSearch.indexRow(article, { wait: true }); // applied, then back
```

`{ wait: true }` is what a script or a test wants — anything that reads the
index back on the next line:

```ts
await articleSearch.indexRow(article, { wait: true });
const { hits } = await index.search('hello'); // it is there
```

A waited write may take up to two minutes before it gives up: a batch on a
large index can be slow. And a waited write is the only one that can fail in
front of you — without `wait`, a task that fails does so where nobody is
looking. The one that catches people out:

```ts
await articleSearch.remove(id, { wait: true });
// SearchSyncError: Search sync "articles:articles" failed removing documents:
// Task 0 (documentDeletion) on index "articles" failed: Index `articles` not found.
```

Meilisearch creates an index on a write of documents, never on a delete. Call
`index.sync()` at startup, or [reindex](reindex.md) first, and the index
exists before anything tries to delete from it.

## Batching

`indexRows` and `removeMany` send `batchSize` documents, or ids, per
Meilisearch task — 500 by default, and set on the sync:

```ts
const articleSearch = createSearchSync({ …, batchSize: 200 });

const rows = await articleRepository.createMany(titles.map((title) => ({ title })));
await articleSearch.indexRows(rows, { wait: true }); // ceil(rows / 200) tasks
```

A list the transform turns into a mix of documents and `null`s becomes two
groups: the documents in one set of tasks, the ids of the `null`s in another.
They never touch the same document, because **`indexRows` deduplicates by
index id first, and the last state of a row wins**:

```ts
// A caller batching its own writes can hand over the same row twice.
await articleSearch.indexRows([{ ...article, draft: true }, article], {
	wait: true,
});
// The last one is the published row, so the document is in the index —
// the delete the draft asked for is not applied after the add.

await articleSearch.indexRows([article, { ...article, draft: true }], {
	wait: true,
});
// The other way round: the row is taken out.
```

`indexRow` and `indexRows` are otherwise the same call; one row is a list of
one.

## In a route

The write, then the index, then the response:

```ts
import { Hono } from 'hono';
import { articleRepository, articleSearch } from './search/articles';

export const articlesRoute = new Hono()
	.post('/articles', async (c) => {
		const body = await c.req.json<{ title: string }>();
		const article = await articleRepository.create({ title: body.title });
		await articleSearch.indexRow(article);
		return c.json(article, 201);
	})
	.patch('/articles/:id', async (c) => {
		const patch = await c.req.json<{ title?: string; draft?: boolean }>();
		const article = await articleRepository.update(c.req.param('id'), patch);
		await articleSearch.indexRow(article); // a draft is taken out by this call
		return c.json(article);
	})
	.delete('/articles/:id', async (c) => {
		const deleted = await articleRepository.delete(c.req.param('id'));
		await articleSearch.removeRow(deleted);
		return c.body(null, 204);
	});
```

Two things worth deciding once, for the whole application:

- **Index after the transaction commits.** Inside `withTransaction`, a row
  that is indexed and then rolled back stays in the index; Meilisearch takes
  no part in the transaction. Index what the transaction returned, after it
  returned.

  ```ts
  import { withTransaction } from '@nxgt/drizzle/pg';

  const article = await withTransaction(db, async (tx) => {
  	const row = await articleRepository.with(tx).update(id, { draft: false });
  	await tagRepository.with(tx).createMany(tags);
  	return row;
  });
  await articleSearch.indexRow(article);
  ```

- **A failed index should not fail the write.** The row is in PostgreSQL
  either way, and [`reindexAll`](reindex.md) puts the index right. Decide
  whether the request is worth failing:

  ```ts
  import type { SearchSyncError } from '@nxgt/drizzle-meilisearch';

  await articleSearch.indexRow(article).catch((error: SearchSyncError) => {
  	log.error({ sync: error.sync, code: error.code, cause: error.cause });
  });
  ```

## Errors

Every failure is a `SearchSyncError`, with the sync's `name` as `sync` and
the original error as `cause`.

| `code` | When |
| --- | --- |
| `ID_MISMATCH` | the transform gave a document whose primary key is not the row's index id. A document under another id could never be taken out again |
| `NOT_A_DOCUMENT` | the transform gave something that is neither a document nor `null`. The message says its shape, never its value |
| `FAILED` | anything else: the transform threw, `toIndexId` threw, Meilisearch refused. The message says what the sync was doing — `failed indexing rows: …`, `failed removing documents: …`, `failed reading an index id: …` |

```ts
import { SearchSyncError } from '@nxgt/drizzle-meilisearch';

try {
	await articleSearch.indexRow(article, { wait: true });
} catch (error) {
	if (error instanceof SearchSyncError) {
		switch (error.code) {
			case 'ID_MISMATCH':
			case 'NOT_A_DOCUMENT':
				log.error({ sync: error.sync, message: error.message }); // the transform is wrong
				break;
			case 'FAILED':
				log.warn({ sync: error.sync, cause: error.cause }); // the index is behind
				break;
		}
	}
	throw error;
}
```

[Troubleshooting](../troubleshooting.md) has each message.

## Signatures

```ts
interface SearchSync<TTable extends PgTable, I extends AnyIndexDefinition> {
	indexRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	indexRows(rows: readonly Row<TTable>[], options?: IndexWriteOptions): Promise<void>;
	removeRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	remove(id: IdOf<I>, options?: IndexWriteOptions): Promise<void>;
	removeMany(ids: readonly IdOf<I>[], options?: IndexWriteOptions): Promise<void>;
}

interface IndexWriteOptions {
	wait?: boolean;
}
```

`remove` and `removeMany` take the index's id type, not the row's: `IdOf<I>`
comes from the index definition, so a number id for a string index does not
compile.

## Next

- [Reindexing](reindex.md) — when the per-write calls are not enough, or were
  missed.
- [Wiring a sync](wiring.md) — the transform, `toIndexId`, and every option.

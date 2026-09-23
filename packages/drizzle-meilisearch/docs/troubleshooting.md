# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut, and a sync's
name is written as it comes out by default — `<table>:<index uid>`, here
`articles:articles`.

Throughout, `articles` is the repository `createRepository(db, articlesTable)`
gives and `articleIndex` is the index `bindIndex` gives: those two are what
`createSearchSync` takes, not the `pgTable` and not the definition.

What this package throws splits in two. The options are refused with a
`TypeError`, where the sync is described, before anything is opened.
Everything after that is a `SearchSyncError` carrying a `code`
(`NOT_A_DOCUMENT`, `ID_MISMATCH`, `FAILED`), the sync's `name` on `sync`, and
the original error as `cause`.

The last section is not errors at all: a row that is in the table and not in
the index, with nothing thrown anywhere. Those are the ones that cost an
afternoon.

| Area | Entries |
| --- | --- |
| [Install](#install) | [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) · [TS2307](#error-ts2307-cannot-find-module-nxgtdrizzle-or-its-corresponding-type-declarations) |
| [Options](#options) | [transform](#createsearchsync-transform-must-be-a-function) · [toIndexId](#createsearchsync-toindexid-must-be-a-function) · [name](#createsearchsync-name-must-not-be-empty) · [batchSize](#createsearchsync-batchsize-must-be-a-whole-number-above-0-not-0) · [pageSize on reindexAll](#reindexall-on-articlesarticles-pagesize-must-be-a-whole-number-above-0-not--1) |
| [The transform](#the-transform) | [not a document](#search-sync-articlesarticles-transform-gave-a-string-for-the-row-) · [an id that is not the index's](#search-sync-articlesarticles-transform-gave-id-other-for-the-row-whose-index-id-is-) · [it threw](#search-sync-articlesarticles-failed-indexing-rows-) |
| [Writing to the index](#writing-to-the-index) | [the index does not exist](#search-sync-articlesarticles-failed-removing-documents-task-0-delete-on-index-articles-failed-index_not_found) · [nothing to search yet](#a-document-indexed-a-moment-ago-is-not-in-the-search-results-yet) |
| [Reindexing](#reindexing) | [small pages](#reindexall-with-a-big-pagesize-still-reads-small-pages) · [a row written during the run](#reindexall-removed-a-row-that-was-just-written) · [a soft-deleted row](#a-soft-deleted-row-is-still-in-the-index) |

## Install

### `npm error ERESOLVE unable to resolve dependency tree`

```
npm error Could not resolve dependency:
npm error peer @nxgt/drizzle@"^0.4.1" from @nxgt/drizzle-meilisearch
```

**When:** `npm install`, before anything is downloaded.

**Why:** this package is a bridge: `@nxgt/drizzle` and `@nxgt/meilisearch` are
**required peers**, and their ranges are carets on 0.x versions, so each
accepts one minor only. The repository and the index are built by those two
packages and handed here, so they have to be the copies this version was built
against. `drizzle-orm`, `meilisearch` and `typescript` are peers on the same
terms.

**Fix:**

```sh
bun add @nxgt/drizzle @nxgt/meilisearch @nxgt/drizzle-meilisearch drizzle-orm@rc meilisearch typescript
```

Raise the siblings rather than install past the conflict: `--force` and
`--legacy-peer-deps` leave two copies of a sibling in the tree, and the types
one of them builds are not the ones this package reads. `bun install` does not
fail here at all — it warns (`warn: incorrect peer dependency`) and carries
on, so read that warning as this error.

### `error TS2307: Cannot find module '@nxgt/drizzle' or its corresponding type declarations.`

At run time the same tree gives
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@nxgt/drizzle'` under
Node, and `error: Cannot find module '@nxgt/drizzle'` under Bun.

**When:** the first build or the first import of your own code, typically
under pnpm or npm with a strict `node_modules` layout.

**Why:** a peer installed *for* this package is not a dependency of **yours**.
It resolves under the bridge alone, so `@nxgt/drizzle-meilisearch` finds it and
your own `import { createRepository } from '@nxgt/drizzle/pg'` does not.

**Fix:** install both siblings yourself — you call them to build the two
arguments this package takes.

```sh
bun add @nxgt/drizzle @nxgt/meilisearch
```

## Options

`createSearchSync` sends nothing and opens nothing: the four refusals below it
throw where the sync is described, not on a first call. The last entry is the
one `reindexAll` makes, on the call itself.

### `createSearchSync: transform must be a function`

**When:** calling `createSearchSync`.

**Why:** `transform` says what a row becomes in the index, and it is missing or
is not callable — usually an object destructured from a config, or an
`await import` whose default was not unwrapped.

**Fix:**

```ts
import { createRepository } from '@nxgt/drizzle/pg';
import { createSearchSync } from '@nxgt/drizzle-meilisearch';
import { bindIndex } from '@nxgt/meilisearch';

const articles = createRepository(db, articlesTable);
const articleIndex = bindIndex(meili, articleIndexDefinition);

const search = createSearchSync({
	repository: articles,
	index: articleIndex,
	toIndexId: (row) => row.id,
	transform: (row) => (row.draft ? null : { id: row.id, title: row.title }),
});
```

`repository` is the repository and `index` is the bound index: the `pgTable`
and the `defineIndex` definition are refused by the types.

### `createSearchSync: toIndexId must be a function`

**When:** calling `createSearchSync`.

**Why:** `toIndexId` is **required here**, where `@nxgt/mongo-meilisearch`
defaults it to `String`. There, the id is `_id` on every document. Here,
Drizzle 1.0's column types do not carry `.primaryKey()`, so neither the table
nor the repository can say at the type level which column the id is in —
nothing could be defaulted to without guessing. One line per sync says it
outright, and says it where the index's own id type checks it.

**Fix:**

```ts
createSearchSync({
	repository: articles,
	index: articleIndex,
	toIndexId: (row) => row.id,
	transform,
});
```

### `createSearchSync: name must not be empty`

**When:** calling `createSearchSync` with `name: ''`.

**Why:** the name is what every error of this sync is reported under, so an
empty one names nothing. Left out, it is `<table>:<index uid>` —
`articles:articles`.

**Fix:**

```ts
createSearchSync({
	repository: articles,
	index: articleIndex,
	toIndexId,
	transform,
	name: 'articles-search',
});
```

Give a name when two syncs would otherwise share the default one.

### `createSearchSync: batchSize must be a whole number above 0, not 0`

The same refusal covers `pageSize`:
`createSearchSync: pageSize must be a whole number above 0, not 1.5`.

**When:** calling `createSearchSync`.

**Why:** both count rows or documents, and `0`, a fraction, `NaN` and a
negative number have no meaning for either. A value read from the environment
is a string until it is parsed, and `Number('')` is `0`.

**Fix:**

```ts
// 500 is the default
createSearchSync({
	repository: articles,
	index: articleIndex,
	toIndexId,
	transform,
	batchSize: 500,
});
```

`pageSize` defaults to `100`.

### `reindexAll on "articles:articles": pageSize must be a whole number above 0, not -1`

**When:** `reindexAll({ pageSize })`, on the call, before a single row is
read. The same option given to `createSearchSync` is refused there instead,
as `createSearchSync: pageSize …`.

**Why:** the refusal names the **call and the sync**, not only the option,
because `pageSize` is given twice — once to `createSearchSync` as the default
for the sync, once to `reindexAll` for that run — and an application running
several syncs would otherwise have to guess which one refused.

**Fix:**

```ts
await search.reindexAll({ pageSize: 100 });
```

## The transform

### `Search sync "articles:articles": transform gave a string for the row …`

The row's index id closes the first sentence, and the message goes on: *It
must give a document to index, or null to keep it out.* Code
`NOT_A_DOCUMENT`, with the sync's `name` on it. An array is reported as
`an array`, and a branch that returns nothing as `undefined`.

**When:** `reindexAll`, `indexRow` or `indexRows` — the first row whose
transform returns something else.

**Why:** the transform gave back something that is not a plain object and is
not `null`: a string, a number, an array, or an implicit `undefined` from a
branch that returns nothing. It reports the **shape** of what came back and
never its value — a transform is handed whole rows, and what it gives back can
hold anything they held.

**Fix:** return `null` for a row that should stay out of the index, and make
every branch return:

```ts
transform: (row) => (row.draft ? null : { id: row.id, title: row.title });
```

`null` also **removes** a document that was in the index, which is how an
unpublish reaches search without a second call.

### `Search sync "articles:articles": transform gave "id" "other" for the row whose index id is …`

The message ends: *A document under another id could never be taken out of the
index again.* Code `ID_MISMATCH`; `"id"` is the index's own `primaryKey`.

**When:** `reindexAll`, `indexRow` or `indexRows`.

**Why:** the document's primary key has to be the same value `toIndexId` gives
for that row, and the two are compared by type as well: `1` and `'1'` are
different ids to Meilisearch. Under any other id, a later `removeRow` would
look for a document that is not there and leave the wrong one in the index for
good.

**Fix:** build the document's key from the same expression as the index id:

```ts
createSearchSync({
	repository: articles,
	index: articleIndex,
	toIndexId: (row) => row.id,
	transform: (row) => ({ id: row.id, title: row.title }),
});
```

With a numeric primary key, convert in both, not in one:

```ts
toIndexId: (row) => Number(row.legacyId),
transform: (row) => ({ n: Number(row.legacyId), title: row.title }),
```

### `Search sync "articles:articles" failed indexing rows: …`

The same wrapper names what the sync was doing: `failed reindexing: …` from
`reindexAll`, `failed indexing rows: …` from `indexRow` and `indexRows`,
`failed removing documents: …` from `removeRow`, `remove` and `removeMany`,
and `failed reading an index id: …` when `toIndexId` throws on the `removeRow`
path, where the id is read before anything is sent, and `failed reporting
progress: …` when `reindexAll`'s `onPage` throws — whatever it threw, a
`SearchSyncError` included, is then the `cause`. A `toIndexId` that throws
under `indexRow` or `indexRows` surfaces as `failed indexing rows`, and under
`reindexAll` as `failed reindexing`. Code `FAILED`, and the original error is
the `cause`.

**When:** any call, as soon as something under it throws — the transform, the
`toIndexId`, the repository's query, or Meilisearch.

**Why:** `FAILED` is the code that means "anything else". The reason after the
colon is the original error's own message, so read the `cause` rather than the
sentence: it is the driver's error, or `SearchIndexError` from
`@nxgt/meilisearch` carrying the failed task.

**Fix:** keep the transform total — catch what you can, and return `null` for a
row you cannot index:

```ts
transform: (row) => {
	try {
		return { id: row.id, title: render(row.body) };
	} catch {
		return null; // out of the index rather than failing the write
	}
};
```

`failed reading an index id` means `toIndexId` threw on a row you passed to
`removeRow` — commonly a row from another table, or a partial object that has
no id on it. Pass the row the repository's `delete` gave back, whole.

## Writing to the index

### `Search sync "articles:articles" failed removing documents: Task 0 (delete) on index "articles" failed: index_not_found`

**When:** the first write of a sync is a **delete** — `removeRow`, `remove` or
`removeMany` with `{ wait: true }`, on an index nothing has created yet.
Meilisearch's own sentence, ``Index `articles` not found.``, is on
`error.cause.cause.message`, not in the message: `@nxgt/meilisearch` keeps
the server's text out of it, since a sentence about a filter or an id quotes
it. Before `@nxgt/meilisearch` 0.4.1 the line ended with
`Task 0 (documentDeletion) … failed: ` and that sentence.

**Why:** Meilisearch creates an index on a write of documents, but **not** on
a delete. Measured in this package's specs. Worse without `wait`: the task is
enqueued, the call returns, and the failure lands in Meilisearch's task queue
where nobody is looking.

**Fix:** create the index before anything writes to it, at startup or in a
migration:

```ts
await articleIndex.sync(); // creates the index, and applies its settings
```

One `reindexAll` also creates it, since it adds documents first — but only if
there is a row to add. `sync` does it on an empty table too, and is the call
that puts the index's settings in place.

### A document indexed a moment ago is not in the search results yet

Nothing is thrown: the call returned, and the search finds nothing.

**When:** right after `indexRow`, `indexRows`, `removeRow`, `remove` or
`removeMany` — most visibly in a test, or in a script that writes and then
reads back.

**Why:** `wait` defaults to `false` on all five. Meilisearch indexes
asynchronously: without `wait`, the call returns as soon as the task is
enqueued, and the document appears a moment later. `reindexAll` is the
exception — it waits for every batch, because what it removes is decided by
reading the index back.

**Fix:** wait where you are about to read:

```ts
await search.indexRow(article, { wait: true });
```

Do not pass it on a request's hot path: a request that has just written a row
should not hold its response open while Meilisearch applies the task.

## Reindexing

### `reindexAll` with a big `pageSize` still reads small pages

**When:** `reindexAll({ pageSize: 1000 })` on a large table — the run is slower
than the number suggests, and the report is still correct.

**Why:** the pages come from the repository, and `@nxgt/drizzle` silently
lowers a `limit` above its `maxPageSize` — `100` by default — to that
maximum. Nothing is thrown here or there; the page is simply smaller than
asked.

**Fix:** raise it on the repository, which is what owns the cap:

```ts
import { createRepository } from '@nxgt/drizzle/pg';

const articles = createRepository(db, articlesTable, { maxPageSize: 1000 });
```

Then `reindexAll({ pageSize: 1000 })` reads pages of 1000. `batchSize` is a
separate number: how many documents go to Meilisearch per request.

### `reindexAll` removed a row that was just written

**When:** a row is created or updated while a `reindexAll` is running, and is
missing from the index — or was removed by that run — once it finishes.

**Why:** nothing here follows the table. PostgreSQL has no change feed this
package reads, so `reindexAll` is a snapshot: a row written after its page was
read is not in the run, and `reindexAll` then removes from the index whatever
the run did not put there.

**Fix:** index each write as it happens, and treat `reindexAll` as the repair,
not the mechanism:

```ts
const article = await articles.create({ title: 'a' });
await search.indexRow(article);
```

Run `reindexAll` when the table is quiet, or accept that a row written during
it needs its own `indexRow` afterwards.

### A soft-deleted row is still in the index

**When:** after a `delete` on a repository with soft delete on — the row is
gone from every query and still comes back in search, until a `reindexAll`
takes it out.

**Why:** `paginateByCursor` does not page soft-deleted rows, so `reindexAll`
does not see the row, does not want it, and removes it. A `delete` on the hot
path does none of that by itself: it is a write like any other, and search only
hears about it if you tell it.

**Fix:** pass the row `delete` gave back:

```ts
const deleted = await articles.delete(id);
await search.removeRow(deleted);
```

A `restore` gives back a row the same way — `indexRow` puts it back. Where the
transform already returns `null` for a deleted row, `indexRow(deleted)` takes
it out too; either call works, as long as one of them is made.

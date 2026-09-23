# Reindexing

`reindexAll()` fills the index from the table: every live row through the
transform, and then out of the index everything the table no longer gives it.

```ts
import { createRepository } from '@nxgt/drizzle/pg';
import { bindIndex } from '@nxgt/meilisearch';
import { createSearchSync } from '@nxgt/drizzle-meilisearch';
import { db, meili } from './clients';              // a Drizzle db, an SDK client
import { articles, articleIndex } from './search';

const index = bindIndex(meili, articleIndex);
const articleSearch = createSearchSync({
	repository: createRepository(db, articles),
	index,
	toIndexId: (article) => article.id,
	transform: (article) =>
		article.draft ? null : { id: article.id, title: article.title },
});

await index.sync(); // the settings, and the index itself
const report = await articleSearch.reindexAll();
// { indexed: 1204, skipped: 17, removed: 3 }
```

| Field | Type | Effect |
| --- | --- | --- |
| `indexed` | `number` | Rows sent to the index |
| `skipped` | `number` | Live rows the transform returned `null` for |
| `removed` | `number` | Documents the index held and the table no longer gives it |

## What it does, in order

1. **Pages the table** with the repository's `paginateByCursor`, `pageSize`
   rows at a time, in primary key order.
2. **Runs the transform** on each row, and sends what it gives in batches of
   `batchSize` — waiting for each batch to be applied.
3. **Reads the index back**, a thousand ids at a time, and deletes every
   document whose id the table did not just give it.

Step 3 is why every batch of step 2 is waited for: a document Meilisearch had
not applied yet would read as absent, and be removed a moment after it was
added. `reindexAll` has no `wait` option, unlike the write calls: it always
waits, and when it returns the index is up to date rather than a moment away
from it.

```ts
await articleSearch.reindexAll();
const { hits } = await index.search('hello'); // already there
```

## What it removes

Everything the index holds and the table does not give back:

- **rows the transform turned away** — a draft, in the example above;
- **rows that were soft-deleted**, since `paginateByCursor` does not page
  them, and a row deleted after the last reindex would otherwise stay
  searchable;
- **documents that were never this table's**, written by something else into
  the same index.

```ts
const gone = await articleRepository.create({ title: 'gone' });
await articleSearch.reindexAll();      // { indexed: 1, skipped: 0, removed: 0 }
await articleRepository.delete(gone.id); // soft delete
await articleSearch.reindexAll();      // { indexed: 0, skipped: 0, removed: 1 }
```

That last point is the sharp edge: **the sync owns its index.** Do not point
a second table, or another writer, at an index a sync reindexes.

An index nothing has ever written to holds nothing, and reading it back says
so rather than failing: on an empty table and a missing index, `reindexAll`
returns `{ indexed: 0, skipped: 0, removed: 0 }`.

## `pageSize`, and the repository's ceiling

`pageSize` is 100 by default, set on the sync, and overridable per call — the
call wins:

```ts
const articleSearch = createSearchSync({ …, pageSize: 50 });
await articleSearch.reindexAll();                  // pages of 50
await articleSearch.reindexAll({ pageSize: 100 }); // pages of 100
```

**A `pageSize` above the repository's `maxPageSize` is silently lowered to
it.** `maxPageSize` is 100 by default, so asking for 1000 here means ten times
more pages, not bigger ones. Raise the ceiling on the repository if you want
larger reads:

```ts
const articleRepository = createRepository(db, articles, { maxPageSize: 1000 });
const articleSearch = createSearchSync({ …, repository: articleRepository, pageSize: 1000 });
```

A `pageSize` that is not a whole number above zero is refused, and the message
names the call it came from and the sync it was called on, since the option
exists on both:

```ts
await articleSearch.reindexAll({ pageSize: -1 });
// TypeError: reindexAll on "articles:articles": pageSize must be a whole
// number above 0, not -1
```

## Progress

`reindexAll` gives its counts once, at the end — on a large table, a long
silence. `onPage` is called after each page, once its documents are applied,
with the running counts:

```ts
await articleSearch.reindexAll({
	pageSize: 500,
	onPage: ({ pages, indexed, skipped }) => {
		console.log(`page ${pages}: ${indexed} indexed, ${skipped} skipped`);
	},
});
```

| Field | |
| --- | --- |
| `pages` | pages read, sent and applied so far |
| `indexed` | rows sent to the index so far |
| `skipped` | rows the transform kept out so far |

It covers the sending half of the call: the removal of what the table no
longer gives comes after the last page, and is in the final report's
`removed`. The counts are the same numbers the report ends with, so the last
`onPage` and the report agree on `indexed` and `skipped`.

`onPage` may be `async`, and is awaited before the next page is read — so a
slow callback slows the reindex, and a callback that writes somewhere can
rely on the page being in the index already.

**One that throws stops the reindex.** The call rejects with a
`SearchSyncError`, code `FAILED`, whose `cause` is what the callback threw.
That is also how to stop a reindex on purpose — the documents already sent
stay, and the removal never ran, as with any reindex that fails half-way:

```ts
const deadline = Date.now() + 10 * 60_000;
await articleSearch.reindexAll({
	onPage: () => {
		if (Date.now() > deadline) throw new Error('out of time');
	},
});
```

## When to run it

- **The first time**, to fill an index from a table that already has rows.
- **After the transform changes** — a new field, a different rule for `null` —
  since the index still holds what the old one produced.
- **After writes that did not reach the index**: a failed `indexRow`, a
  migration or a bulk `UPDATE` run straight in SQL, an import.
- **On a schedule**, as the safety net under the per-write calls, since
  nothing here follows the table.

It is a **deployment or cron step, not a request-time one**: it holds one id
per live row in memory and pages the whole index to decide what to remove,
which on a table of millions is a large set and a full pass over the index.

A row written while it runs is only seen if the page it belongs to has not
been read yet; [`indexRow`](indexing-writes.md) is what covers that.

## In a script

```ts
#!/usr/bin/env bun
import { SearchSyncError } from '@nxgt/drizzle-meilisearch';
import { articleSearch, index } from './search/articles';

await index.sync(); // settings first: reindexing into a stale index is wasted work

try {
	const report = await articleSearch.reindexAll({
		onPage: ({ pages, indexed }) => console.log(`… page ${pages}, ${indexed} indexed`),
	});
	console.log(
		`${articleSearch.name}: indexed ${report.indexed}, skipped ${report.skipped}, removed ${report.removed}`,
	);
} catch (error) {
	if (error instanceof SearchSyncError) {
		console.error(`${error.sync}: ${error.code}`, error.cause);
		process.exit(1);
	}
	throw error;
}
```

## Errors

Anything that goes wrong comes back as a `SearchSyncError` with the code
`FAILED` — PostgreSQL refused a read, Meilisearch refused a batch, the
transform threw — with the original error as `cause` and `failed reindexing:`
in the message. Two codes are more precise, and both are the transform's
doing: `ID_MISMATCH`, a document whose primary key is not the row's index id,
and `NOT_A_DOCUMENT`, something that is neither a document nor `null`.

A reindex that throws leaves the index as far as it got: the batches already
sent are there, and the removal may not have run at all. Nothing is recorded
anywhere, so running it again starts over.

[Troubleshooting](../troubleshooting.md) has each message.

## Signatures

```ts
interface SearchSync<TTable extends PgTable, I extends AnyIndexDefinition> {
	reindexAll(options?: ReindexOptions): Promise<ReindexReport>;
}

interface ReindexOptions {
	pageSize?: number;
	onPage?: (progress: ReindexProgress) => void | Promise<void>;
}

interface ReindexProgress {
	readonly pages: number;
	readonly indexed: number;
	readonly skipped: number;
}

interface ReindexReport {
	indexed: number;
	skipped: number;
	removed: number;
}
```

## Next

- [Indexing after a write](indexing-writes.md) — what keeps the index in step
  between reindexes.
- [Wiring a sync](wiring.md) — `pageSize`, `batchSize` and the rest.

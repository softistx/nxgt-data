# Reindexing

`reindex()` fills the index from the collection: every live document through
the transform, and then out of the index everything the collection no longer
gives it.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection } from '@nxgt/mongo';
import { createSearchSync } from '@nxgt/mongo-meilisearch';
import { db, meili } from './clients';            // a driver Db, an SDK client
import { articles, articleIndex } from './search';

const articleSearch = createSearchSync({
	collection: getCollection(db, articles),
	index: bindIndex(meili, articleIndex),
	transform: (article) =>
		article.draft ? null : { id: String(article._id), title: article.title },
});

const report = await articleSearch.reindex();
// { indexed: 1204, skipped: 17, removed: 3 }
```

| Field | Type | Effect |
| --- | --- | --- |
| `indexed` | `number` | Documents sent to the index |
| `skipped` | `number` | Live documents the transform returned `null` for |
| `removed` | `number` | Documents the index held and the collection no longer gives it |

## What it does, in order

1. **Takes the collection's current position** — a change stream's first read
   answers with it, without waiting for a change.
2. **Reads every live document**, `pageSize` at a time (100 by default,
   lowered to the collection's `maxPageSize` when it asks for more), runs the
   transform, and sends what it gives in batches of `batchSize` (500).
   Soft-deleted documents are not live, so they are never sent.
3. **Pages the whole index** and deletes every document whose id the
   collection did not just give it: deleted, turned away by the transform, or
   never from this collection at all.
4. **Records the position from step 1** as the resume point, and stamps
   `reindexedAt`.

Step 1 before step 2 is what makes it safe to reindex a live collection: a
change made while the documents are read is followed again from that
position, so nothing falls between the reindex and the stream. A reindex that
throws records nothing, and the next one starts over.

```ts
const before = await articleSearch.state(); // undefined, the first time
await articleSearch.reindex();
const after = await articleSearch.state();
after?.reindexedAt; // a Date
```

## When to run it

- **The first `start`** runs it for you, when nothing is recorded under the
  sync's name.
- **After the transform changes** — a new field, a different rule for `null`
  — since the index still holds what the old one produced.
- **After a stop longer than the server's change history**, which `start`
  does itself unless `onHistoryLost: 'fail'` asks to decide.
  See [Following changes](following-changes.md).

It is a **deployment step, not a request-time one**: it holds one id per live
document in memory and scans the whole index, which on a collection of
millions is hundreds of megabytes and a full pass over the index.

## Not beside its own follower

```ts
const running = await articleSearch.start();
await articleSearch.reindex();
// SearchSyncError: Search sync "articles:articles" is already following
// changes in this process: close it before you reindex.
```

The code is `RUNNING`. A reindex removes what the follower has just indexed,
and the follower, having already handled that change, would never send it
again. Close the follower, reindex, start again:

```ts
await running.close();
await articleSearch.reindex();
const fresh = await articleSearch.start();
```

The check is per object and per process: the package has no lock across
processes, and [does not pretend to](boundaries.md).

## Errors

Anything that goes wrong while reindexing comes back as a `SearchSyncError`
with the code `FAILED` — MongoDB refused a read, Meilisearch refused a batch,
the transform threw — and the original error as its `cause`:

```ts
try {
	await articleSearch.reindex();
} catch (error) {
	if (error instanceof SearchSyncError) {
		console.error(error.code, error.sync, error.cause);
	}
	throw error;
}
```

Two codes mean something more precise than `FAILED`, and both are the
transform's doing. `ID_MISMATCH`: it gave a document whose primary key is not
that document's index id. `NOT_A_DOCUMENT`: it gave back something that is
neither a document nor `null`.

```ts
const transform = (article: Article) =>
	article.draft ? null : { id: String(article._id), title: article.title };
// Anything else — a string, a number, an array — is NOT_A_DOCUMENT, and the
// message reports its shape rather than its value.
```

[Troubleshooting](../troubleshooting.md) has each message.

## Signatures

```ts
interface SearchSync {
	reindex(): Promise<ReindexReport>;
}

interface ReindexReport {
	indexed: number;
	skipped: number;
	removed: number;
}
```

## Next

- [Following changes](following-changes.md) — what runs after the fill.
- [The sync's lifecycle](sync-lifecycle.md) — `pageSize`, `batchSize` and the
  rest.

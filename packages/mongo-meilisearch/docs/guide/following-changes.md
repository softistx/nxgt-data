# Following changes

`start()` follows the collection's change stream into the index, from where
the last run stopped, and gives back the running sync.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection, type ReadDocumentOf } from '@nxgt/mongo';
import { createSearchSync } from '@nxgt/mongo-meilisearch';
import { db, meili } from './clients';            // a driver Db, an SDK client
import { articles, articleIndex } from './search';

const collection = getCollection(db, articles);
const index = bindIndex(meili, articleIndex);
const transform = (article: ReadDocumentOf<typeof articles>) =>
	article.draft ? null : { id: String(article._id), title: article.title };

const articleSearch = createSearchSync({ collection, index, transform });

const running = await articleSearch.start();
await running.ready;   // already resolved: start waits for the stream to open
await running.flush(); // sends what is waiting now, and records how far it got
await running.close(); // flushes, then stops
```

`RunningSearchSync` is `AsyncDisposable`, so
`await using running = await articleSearch.start()` closes it at the end of
the block.

| Member | Type | Effect |
| --- | --- | --- |
| `ready` | `Promise<void>` | Resolves once changes are being heard. `start` has already awaited it |
| `closed` | `Promise<CloseReason>` | `'closed'` after `close()`, `'invalidated'` when the collection was dropped or renamed. **Rejects** with a `SearchSyncError` when an error stopped it |
| `flush()` | `Promise<void>` | Sends what is waiting, and records the point it covers |
| `close()` | `Promise<void>` | Flushes, then stops |

## Where it starts from

- **Nothing recorded** — the first run under this `name` — it
  [reindexes](reindex.md), then follows from the position the reindex saved.
- **Something recorded**: it resumes there, so a change made while no process
  was following is applied now.
- **A position the server's history no longer reaches**: see
  [When the history is gone](#when-the-history-is-gone).

## What reaches the index

Every create, update, soft delete, restore and hard delete of the collection
runs through the transform:

```ts
await collection.create({ title: 'written' });   // added to the index
await collection.update(id, { draft: true });    // transform returns null → removed
await collection.update(id, { draft: false });   // back in
await collection.delete(id);                     // soft delete → removed
await collection.hardDelete(id);                 // removed
```

Changes are sent in **batches**: one waits `flushIntervalMs` (1000 ms) for
others, or goes at once as soon as `batchSize` (500) are waiting. Several
changes to one document within a batch send only the last — the batch holds
one entry per id, so adds and deletes never race.

The resume point is recorded **after** the batch is applied. What was not
sent when a process stops is sent again by the next `start`, so a change may
reach the index twice; the transform is a function of the document, so
applying it twice is applying it once.

## A quiet collection keeps its position fresh

Every `positionIntervalMs` (60 s), a sync with nothing to send records where
the stream is anyway — one small write per interval, and none at all while
the stream itself does not move.

Without it, a collection nothing writes to for longer than the server's
history covers would need a full reindex at the next start.

## When the history is gone

MongoDB keeps a bounded history of changes, the oplog. A sync stopped for
longer than it covers cannot resume from its recorded point. By default
`start` reindexes and follows from there. `onHistoryLost: 'fail'` hands the
decision back:

```ts
import { SearchSyncError } from '@nxgt/mongo-meilisearch';

const articleSearch = createSearchSync({
	collection,
	index,
	transform,
	onHistoryLost: 'fail',
});

let running: RunningSearchSync;
try {
	running = await articleSearch.start();
} catch (error) {
	if (error instanceof SearchSyncError && error.code === 'HISTORY_LOST') {
		await articleSearch.reindex(); // when it suits you
		running = await articleSearch.start();
	} else throw error;
}
```

`onHistoryLost` applies to `start` alone. A history that runs out **under** a
running sync stops it with `FAILED`; the next `start` is where the choice is
made again.

## When it stops

```ts
running.closed.then(
	(reason) => console.info(`sync stopped: ${reason}`), // 'closed' | 'invalidated'
	(error: SearchSyncError) => {
		console.error({ sync: error.sync, code: error.code, cause: error.cause });
		process.exit(1); // let the supervisor restart it
	},
);
```

- **`close()`** — `closed` resolves `'closed'`. What was waiting is flushed
  and recorded first.
- **The collection is dropped or renamed** — `closed` resolves
  `'invalidated'`, and the recorded point is forgotten, since nothing could
  resume from inside a collection that no longer exists. The next `start`
  reindexes what the recreated collection holds.
- **An error** — `closed` rejects with a `SearchSyncError`, and so do `flush`
  and `close` from then on. Nothing past the last applied batch was recorded,
  so the next `start` sends it again.

**Await `closed`, or catch it.** A rejection nobody handles ends the process.

| `code` | When |
| --- | --- |
| `HISTORY_LOST` | `start` with `onHistoryLost: 'fail'`, and the recorded point is older than the server's history. `cause` is `@nxgt/mongo`'s `DataError`, `serverCode` 286 or 280 |
| `ID_MISMATCH` | the transform gave a document whose primary key is not its index id |
| `RUNNING` | a second `start()`, or a `reindex()`, while this sync is already following in this process |
| `FAILED` | anything else: the transform threw, MongoDB or Meilisearch refused. The message says what the sync was doing, and `cause` carries the original error |

[Troubleshooting](../troubleshooting.md) has each message with its fix.

## In a worker

```ts
const running = await articleSearch.start();

const stop = async () => {
	await running.close(); // flushes and records before exiting
	await mongo.close();
	process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await running.closed; // rejects if the sync falls over; the supervisor restarts it
```

One process per sync name: there is no lock, and two followers do the same
writes twice. See [What it leaves out](boundaries.md).

## Signatures

```ts
interface SearchSync {
	start(): Promise<RunningSearchSync>;
}

interface RunningSearchSync extends AsyncDisposable {
	readonly ready: Promise<void>;
	readonly closed: Promise<CloseReason>; // 'closed' | 'invalidated'
	flush(): Promise<void>;
	close(): Promise<void>;
}

class SearchSyncError extends Error {
	readonly code: SearchSyncErrorCode; // 'HISTORY_LOST' | 'ID_MISMATCH' | 'RUNNING' | 'FAILED'
	readonly sync: string;
	constructor(message: string, options: SearchSyncErrorOptions);
}

interface SearchSyncErrorOptions {
	code: SearchSyncErrorCode;
	sync: string;
	cause?: unknown;
}
```

`CloseReason` is `@nxgt/mongo`'s; its third value, `'failed'`, never occurs
here — a failure rejects instead.

## Next

- [Reindexing](reindex.md) — the fill `start` runs the first time.
- [What it leaves out](boundaries.md).

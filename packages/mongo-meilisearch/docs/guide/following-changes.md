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
| `close()` | `Promise<void>` | Flushes, stops, and lets go of the name's lease; resolves once it is let go |

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

## One process per name: the lease

`start()` takes a lease on the sync's name **before anything else**, the
first reindex included. It renews the lease every third of `leaseMs` from
then on — during that first reindex too, which can outlast `leaseMs`, and
while the sync runs; `close()` lets go of it. A second process that starts
the same name, or reindexes it, is refused:

```ts
await articleSearch.start(); // in another process, holding the name
// SearchSyncError: Search sync "articles:articles" is held by
// worker-1:4127:66f0c2e5a1b2c3d4e5f60718 until 2026-09-22T09:14:07.512Z: wait
// for it to close, or for its lease to lapse, before you start it.
```

The code is `RUNNING`, the same code a second `start()` of the same object
gets in one process (`is already following changes in this process`), which
is checked first. The holder is `host:pid:<id>`, and the date is when its
lease ends unless it is renewed. For `reindex()` the message ends
`before you reindex.`

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `leaseMs` | `number` | `30000` | How long the lease lasts without being renewed. A running sync renews it every `leaseMs / 3`. A whole number above 0 |

```ts
const articleSearch = createSearchSync({ collection, index, transform, leaseMs: 60_000 });
```

- **`close()` resolves once the name is free**, so a `reindex()` or a
  `start()` right after it succeeds. A `start()` that fails lets go too.
- **A process that dies keeps the name** until its lease lapses, at most
  `leaseMs` later. The next `start()` after that takes it over.
- **A renewal that cannot reach MongoDB is tried again** at the next beat;
  the lease lapses only if none reaches it for a whole `leaseMs`.
- **The lease is a document in `stateCollection`**:
  `{ _id: { lease: <name> }, holder, acquiredAt, expiresAt }`, every time
  the server's own clock, so hosts whose clocks disagree still agree on when
  it lapses. No new collection, no new privilege.

### A standby

Several processes can run the same code; one follows, the others wait for
the name. The loop is `follow()`, in the README's
[One process per sync name](../../README.md#one-process-per-sync-name): it
retries `start()` on `RUNNING`, and on `LEASE_LOST`, which a `start()` whose
first reindex lost the name rejects with.

```ts
const running = await follow(); // resolves once this process holds the name
```

### When the lease is lost

A process stalled for longer than `leaseMs` — a long garbage collection, a
blocked event loop, a paused container — may find, at its next renewal, that
another process has taken the name over. A lease deleted by hand is found the
same way. The sync then stops rather than run beside the new holder, whose
lease it leaves alone.

**While following**, `closed` rejects with `LEASE_LOST`, and nothing more is
sent or recorded beyond a flush already in flight:

```ts
running.closed.catch((error: SearchSyncError) => {
	// error.code === 'LEASE_LOST'
	// error.message: Search sync "articles:articles" lost its lease: another
	// process holds the name now, or the lease was removed (it lapses when not
	// renewed within 30000 ms). It stopped rather than run beside it.
	process.exit(1); // the supervisor restarts it, and `follow()` waits for the name
});
```

**While reindexing** — a standalone `reindex()`, or `start()` during its first
reindex or the one after a lost history — the lease is checked after each page
sent, and the server is asked before documents are removed and again before the
resume point is recorded; `start()` asks once more before it opens the
follower. The call rejects with `LEASE_LOST` **having recorded nothing**, and
having removed nothing unless the lease went while the removal itself ran. The
pages already sent stay in the index.

```ts
import { SearchSyncError } from '@nxgt/mongo-meilisearch';

try {
	await articleSearch.reindex();
} catch (error) {
	if (error instanceof SearchSyncError && error.code === 'LEASE_LOST') {
		// Another process holds the name now; nothing was recorded.
	} else throw error;
}
```

It is a lease, not fencing:

- **A stalled follower may send stale data.** Until its next renewal — up to
  `leaseMs / 3` after it wakes — it can still send, and a flush already in
  flight finishes after the loss is found. It may send an older version of a
  document after the new holder sent a newer one; the index then holds the
  stale one until that document's next change, or the next reindex.
- **A reindex's pages may still land.** It removes and records nothing once
  it finds its lease lost, but a page it sent before finding out stays in the
  index.

Pick `leaseMs` well above the longest pause a process may take.

## When the history is gone

MongoDB keeps a bounded history of changes, the oplog. A sync stopped for
longer than it covers cannot resume from its recorded point. By default
`start` reindexes and follows from there. `onHistoryLost: 'fail'` hands the
decision back:

```ts
import { type RunningSearchSync, SearchSyncError } from '@nxgt/mongo-meilisearch';

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
| `NOT_A_DOCUMENT` | the transform gave back something that is neither a document nor `null` — a string, a number, an array. The message says its shape, never its value |
| `RUNNING` | the name is taken: a second `start()`, or a `reindex()`, while this sync is already following in this process — or another process, or another `createSearchSync` of the same name in this one, holds its lease |
| `LEASE_LOST` | the lease is no longer this sync's: not renewed within `leaseMs` and taken over, or removed. `closed` rejects with it, and nothing more is sent; `reindex()` and `start()` reject with it while reindexing, having recorded nothing, and removed nothing unless the lease went while the removal itself ran |
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

`close()` lets go of the lease before it resolves, so the next worker to
start takes the name at once instead of waiting `leaseMs`. See
[What it leaves out](boundaries.md) for what the lease does not give.

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
	// 'HISTORY_LOST' | 'ID_MISMATCH' | 'NOT_A_DOCUMENT' | 'RUNNING' | 'LEASE_LOST' | 'FAILED'
	readonly code: SearchSyncErrorCode;
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

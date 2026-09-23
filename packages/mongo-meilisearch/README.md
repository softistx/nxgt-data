# @nxgt/mongo-meilisearch

Keeps a [Meilisearch](https://www.meilisearch.com) index in step with a
MongoDB collection: a typed transform from one to the other, a full reindex,
and a change stream that picks up where it stopped, its position kept in
MongoDB.

```ts
import { createSearchSync } from '@nxgt/mongo-meilisearch';

const articleSearch = createSearchSync({
	collection: getCollection(db, articles),      // @nxgt/mongo
	index: bindIndex(meili, articleIndex),        // @nxgt/meilisearch
	transform: (article) =>
		article.draft
			? null
			: { id: String(article._id), title: article.title, body: article.body },
});

const running = await articleSearch.start(); // reindexes the first time, then follows
// …
await running.close();
```

`transform` takes the collection's document, typed by its schema, and gives
the index's document, typed by its definition; `null` keeps a document out
of the index, and takes it out if it was in. Every create, update, soft
delete, restore and hard delete reaches the index, in batches.

> **0.x, on `@nxgt/mongo` and `@nxgt/meilisearch`.** The API is still settling.

## Install

```sh
bun add @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch mongodb meilisearch zod
```

- `@nxgt/mongo` and `@nxgt/meilisearch`: required peers. The collection and
  the index are theirs, and so are their options; this package creates
  neither client.
- `mongodb` `>=7.0.0 <8` and `meilisearch` `>=0.62.0 <1`: required peers,
  as the two packages above need them. `zod` is `@nxgt/mongo`'s.
- `typescript` 6: required peer, the version every `@nxgt` package pins.
- A MongoDB **replica set** or sharded cluster, since change streams need
  one, and a Meilisearch server, 1.x. Tested against MongoDB 8.2 and
  Meilisearch 1.53.

## Setup

The collection and the index are defined as their packages define them:

```ts
import { defineCollection, id } from '@nxgt/mongo';
import { defineIndex } from '@nxgt/meilisearch';
import { z } from 'zod';

export const articles = defineCollection({
	name: 'articles',
	schema: z.object({
		_id: id(),
		title: z.string(),
		body: z.string(),
		draft: z.boolean().default(false),
	}),
	timestamps: true,
	softDelete: true,
});

export interface ArticleHit {
	id: string;
	title: string;
	body: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title', 'body'] },
});
```

Then, in the process that keeps the index up to date:

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection } from '@nxgt/mongo';
import { createSearchSync } from '@nxgt/mongo-meilisearch';

const index = bindIndex(meili, articleIndex);
await index.sync(); // the index's settings are @nxgt/meilisearch's to apply

const articleSearch = createSearchSync({
	collection: getCollection(db, articles),
	index,
	transform: (article) =>
		article.draft
			? null
			: { id: String(article._id), title: article.title, body: article.body },
});

const running = await articleSearch.start();
process.on('SIGTERM', () => running.close());
await running.closed; // rejects with a SearchSyncError if the sync stops on an error
```

`createSearchSync` sends nothing: `reindex` and `start` do.

## Reindex

```ts
const report = await articleSearch.reindex();
// { indexed: 1204, skipped: 17, removed: 3 }
```

It reads every live document, a page at a time (`pageSize`, 100 by
default), sends what the transform gives in batches (`batchSize`, 500), and
then removes from the index every document the collection no longer gives
it: deleted, turned away by the transform, or never from this collection.

It first records where the collection's changes are, and saves that point
when it is done: a change made while it reads is followed again from there,
so none falls between the reindex and the stream. A reindex that fails
records nothing, and one that finds its lease taken over stops before it
removes anything more (see *One process per sync name*).

## Following changes

```ts
const running = await articleSearch.start();
await running.ready;   // already resolved: start waits for the stream to open
await running.flush(); // sends what is waiting now, and records how far it got
await running.close(); // flushes, then stops; or `await using running = …`
```

- **The first `start` reindexes.** With nothing recorded under the sync's
  name, it reindexes, then follows from the point the reindex saved.
- **Later ones pick up where the last stopped.** A change made while no
  process was following is applied on the next `start`, from the recorded
  point.
- **Changes go in batches.** A change waits `flushIntervalMs` (1000 ms) for
  others, or goes at once when `batchSize` of them are waiting. Several
  changes to one document send only the last.
- **The point is recorded after the batch is applied**, in
  `stateCollection` (`nxgt_search_sync`, in the collection's database),
  under the sync's `name` (`'<collection>:<index uid>'`). What was not sent
  when a process stops is sent again by the next `start`.
- **Every change runs the transform.** A document that stops qualifying is
  taken out; a soft-deleted one is taken out, and a restored one comes back.
- **A quiet collection keeps its point fresh.** Every `positionIntervalMs`
  (60 s), a sync with nothing to send records where the stream is anyway.
  Without it, a collection nothing writes to for longer than the server's
  history covers would need a full reindex at the next start. Nothing is
  written while the stream itself does not move on.
- **A dropped collection ends the sync** — `closed` resolves
  `'invalidated'` — and its recorded point goes with it, since nothing could
  resume from inside a collection that no longer exists. The next `start`
  reindexes what the recreated collection holds.

### One process per sync name

`start` takes a **lease** on the sync's name before anything else, the first
reindex included, and a running sync renews it every third of `leaseMs`
(30 s). A second process that starts the same name is refused with
`RUNNING`, naming who holds it and until when. Run it as a standby that
tries again — on `RUNNING`, and on `LEASE_LOST`, which a `start()` whose
first reindex lost the name to another process rejects with:

```ts
import { type RunningSearchSync, SearchSyncError } from '@nxgt/mongo-meilisearch';

// The name is held elsewhere, or was taken over while this start reindexed.
const heldElsewhere = (error: unknown) =>
	error instanceof SearchSyncError &&
	(error.code === 'RUNNING' || error.code === 'LEASE_LOST');

async function follow(): Promise<RunningSearchSync> {
	for (;;) {
		try {
			return await articleSearch.start();
		} catch (error) {
			if (!heldElsewhere(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}
}
```

A restart inside a crashed follower's `leaseMs` gets `RUNNING` too: run this
loop rather than exit.

- **`close()` lets go of the name**, and resolves once it has: a `start` or a
  `reindex` right after finds it free. A `start` that fails lets go too.
- **A process that dies keeps the name** until its lease lapses, at most
  `leaseMs` later; the next `start` then takes it over.
- **`reindex()` on its own takes the lease** for as long as it runs, so it
  cannot run beside a follower in another process. `start()` renews it
  during its first reindex too.
- **A sync that loses its lease stops.** When a renewal finds the name held
  by someone else — this process stalled for longer than `leaseMs`, and
  another took over — `closed` rejects with `LEASE_LOST`, and nothing more is
  sent.
- **A reindex that loses its lease stops too.** `reindex()`, and `start()`
  while it reindexes, check the lease after each page, and ask the server
  before removing documents and again before recording the resume point;
  `start()` asks once more before it opens the follower. They reject with
  `LEASE_LOST` having recorded nothing, and removed nothing unless the lease
  went while the removal itself ran; the pages already sent stay in the index.

The lease is a document in `stateCollection`, `_id: { lease: <name> }`, its
times the server's own: no new collection and no new privilege.

### When the history is gone

MongoDB keeps a bounded history of changes, the oplog. A sync stopped for
longer than it covers cannot resume. `start` then reindexes and follows from
there, or, with `onHistoryLost: 'fail'`, throws a `SearchSyncError` with the
code `HISTORY_LOST`, for an app that would rather decide when a full
reindex runs.

```ts
const articleSearch = createSearchSync({ …, onHistoryLost: 'fail' });

try {
	running = await articleSearch.start();
} catch (error) {
	if (error instanceof SearchSyncError && error.code === 'HISTORY_LOST') {
		await articleSearch.reindex(); // when it suits you
		running = await articleSearch.start();
	} else throw error;
}
```

### Ids that are not strings

The index id of a document is `String(_id)` by default, which suits an
`ObjectId`. When the index's primary key is a number, say how to get it:

```ts
createSearchSync({
	collection: getCollection(db, counters), // _id: z.int()
	index: bindIndex(meili, counterIndex),   // primaryKey: 'n', a number
	toIndexId: (id) => id,
	transform: (counter) => ({ n: counter._id, label: counter.label }),
});
```

The transform must give each document its index id as primary key: a
document under another id could never be taken out again, and throws
`ID_MISMATCH`. It must also give back a document, or `null` to keep the
document out of the index; anything else is `NOT_A_DOCUMENT`.

## Errors

This package throws `SearchSyncError`; what caused it is its `cause`.

| `code` | When |
| --- | --- |
| `HISTORY_LOST` | `start` with `onHistoryLost: 'fail'`, and the recorded point is older than the server's history. `cause` is `@nxgt/mongo`'s `DataError`, `serverCode` 286 or 280 |
| `ID_MISMATCH` | the transform gave a document whose primary key is not its index id |
| `NOT_A_DOCUMENT` | the transform gave back something that is neither a document nor `null` — a string, a number, an array. The message says its shape, never its value |
| `RUNNING` | the name is taken. On this sync object: `reindex()` or a second `start()` while it is already following. Through the lease: `start()` or `reindex()` while another process holds the name — or another `createSearchSync` with the same name in this process, whose holder then starts with this process's own `host:pid`. The message names the holder and when its lease ends |
| `LEASE_LOST` | the name's lease is no longer this sync's: it was not renewed within `leaseMs` and another process took it over, or it was removed. `closed` rejects with it, and nothing more is sent; `reindex()` and `start()` reject with it while reindexing, having recorded nothing, and removed nothing unless the lease went while the removal itself ran |
| `FAILED` | anything else: the transform threw, MongoDB or Meilisearch refused. The message says what the sync was doing |

A running sync that meets one stops: `closed` rejects with it, and `flush`
and `close` reject with it too. Nothing past the last applied batch is
recorded, so the next `start` sends it again.

```ts
running.closed.catch((error: SearchSyncError) => {
	log.error({ sync: error.sync, code: error.code, cause: error.cause });
	process.exit(1); // let the supervisor restart it
});
```

`onHistoryLost` applies to `start` alone. A history that runs out under a
running sync stops it with `FAILED`; the next `start` is where the choice is
made again.

`createSearchSync` throws a `TypeError` before anything runs: for an option
out of range, an empty `name`, or a `transform` that is not a function.

## Not included

- **Sharing one name's work between processes.** One process follows a
  name at a time; the others wait for its lease. To spread the load, give
  each process its own collection and name.
- **Fencing.** The lease keeps a second process out, but does not stop a
  stalled one mid-write; see *Traps*.
- **Partial updates.** A change sends the whole document the transform
  gives, never a patch.
- **Keeping the index's settings.** That is `@nxgt/meilisearch`'s `sync`.
- **Joining other collections into a document.** The transform may read
  them, but a change to them does not reach the index.

## API

### `createSearchSync(options)`

```ts
function createSearchSync<C extends AnyCollectionDefinition, I extends AnyIndexDefinition>(
	options: SearchSyncOptions<C, I>,
): SearchSync;
```

`SearchSyncOptions<C, I>`:

| Option | Default | |
| --- | --- | --- |
| `collection: TypedCollection<C>` | | from `getCollection` |
| `index: TypedIndex<I>` | | from `bindIndex` |
| `transform: Transform<C, I>` | | `(document: ReadDocumentOf<C>) => DocumentOf<I> \| null`, or a promise of it. `ReadDocumentOf` is `@nxgt/mongo`'s, `DocumentOf` `@nxgt/meilisearch`'s |
| `toIndexId: ToIndexId<C, I>` | `String` | `(id: IdOf<C>) => IdOf<I>`, the first from `@nxgt/mongo` and the second from `@nxgt/meilisearch`; required when the index's ids are not strings |
| `name: string` | `'<collection>:<index uid>'` | what the state is recorded under |
| `stateCollection: string` | `'nxgt_search_sync'` | in the collection's database |
| `batchSize: number` | `500` | changes sent at once |
| `flushIntervalMs: number` | `1000` | how long a change waits for others; `0` sends at the next tick |
| `positionIntervalMs: number` | `60000` | how often a sync with nothing to send records where the stream is |
| `leaseMs: number` | `30000` | how long the lease on the name lasts unrenewed; a running sync renews it every third of that |
| `pageSize: number` | `100` | documents a reindex reads per page; above the collection's `maxPageSize`, lowered to it |
| `onHistoryLost: 'reindex' \| 'fail'` | `'reindex'` | |

`SearchSync`:

| Member | |
| --- | --- |
| `name: string` | |
| `reindex(): Promise<ReindexReport>` | `{ indexed, skipped, removed }` |
| `start(): Promise<RunningSearchSync>` | resolves once changes are heard |
| `state(): Promise<SearchSyncState \| undefined>` | `{ _id, resumeToken, updatedAt, reindexedAt }`; `undefined` before the first reindex |

`RunningSearchSync`, also `AsyncDisposable`:

| Member | |
| --- | --- |
| `ready: Promise<void>` | resolved |
| `closed: Promise<CloseReason>` | `'closed'` after `close`, `'invalidated'` when the collection was dropped or renamed; rejects with a `SearchSyncError`. `CloseReason` is `@nxgt/mongo`'s, and its third value, `'failed'`, never occurs here |
| `flush(): Promise<void>` | sends what waits, records the point |
| `close(): Promise<void>` | flushes, then stops |

`class SearchSyncError extends Error`: `code: SearchSyncErrorCode`
(`'HISTORY_LOST' | 'ID_MISMATCH' | 'NOT_A_DOCUMENT' | 'RUNNING' | 'LEASE_LOST' | 'FAILED'`),
`sync: string`,
`cause`. Its constructor takes `(message, options: SearchSyncErrorOptions)`,
that is `{ code, sync, cause? }`; both types are exported.

## What does not compile

Each is a `@ts-expect-error` case in this package's type tests.

- A transform that reads a field the collection's schema does not have.
- A transform that leaves out a field the index's document has, or gives an
  id of the wrong type (an `ObjectId` for a string id). A field the document
  does not have, beside all the ones it does, is passed on to Meilisearch.
- A transform that gives something other than a document or `null`.
- No `toIndexId` when the index's ids are not strings; one that gives
  another type than the index's ids, or takes another than the collection's.
- A driver `Collection` for `collection`, or the SDK's `Index` for `index`.
- No `transform`, an option this package does not have, or an
  `onHistoryLost` other than `'reindex'` or `'fail'`.

## Traps

- **The sync owns its index.** A reindex removes every document the
  collection does not give it, whoever wrote it. Do not point two
  collections, or another writer, at one index.
- **A reindex holds one id per live document in memory**, and then pages the
  whole index to find what to remove (`reindex.ts`). On a collection of
  millions that is hundreds of megabytes and a full index scan, so a reindex
  is a deployment step and not something to run per request.
- **A change may be applied twice.** Changes after the last recorded point
  are sent again after a restart or a failure. Keep the transform a function
  of the document alone.
- **A transform that throws stops the sync**, and the same document stops
  it again on the next `start`. Catch what you can in the transform, and
  return `null` for a document you cannot index.
- **Await `closed`, or catch it.** A sync that stops on an error rejects
  it, and a rejection nobody handles ends the process.
- **Without post-images, a change carries the document as it is now**, not
  as the change left it (`@nxgt/mongo`'s change streams). For an index, where
  only the latest state counts, that is what you want.
- **A lease is not fencing.** A stalled process learns it lost the name at
  its next renewal (up to `leaseMs / 3` after it wakes), and a flush already
  in flight still finishes. It may send an older version of a document after
  the new holder sent a newer one; the index then holds the stale one until
  that document's next change or the next reindex. A reindex removes and
  records nothing once it finds its lease lost, but a page it already sent may
  still land. Keep `leaseMs` well above the longest pause a process may take
  (garbage collection, a blocked event loop).
- **Two syncs over the same collection and index share a name**, and so a
  lease: give them different `name`s when both are meant to run.
- **A dropped collection stops the sync** (`'invalidated'`) and leaves the
  index as it was. What the collection had is removed by the reindex the
  next `start` runs.
- **Meilisearch has its own rules for ids**: letters, digits, `-` and `_`.
  An id it refuses fails the batch, and the sync. An `ObjectId`'s hex string
  is fine.
- **A write waits up to two minutes** for Meilisearch to apply it; a batch
  on a large index can be slow, and the sync waits.
- **The user needs** `find` and `changeStream` on the collection, and
  `find`, `insert`, `update` and `delete` on `stateCollection`; the
  Meilisearch key needs `documents.add`, `documents.get`,
  `documents.delete` and `tasks.get`, plus `indexes.create` unless the index
  already exists — the first write to an index that does not creates it.

## Documentation

- [Guide index](docs/README.md) — every page, and when to read it.
- [The sync's lifecycle](docs/guide/sync-lifecycle.md) — the two definitions,
  the transform, and every option with its default.
- [Reindexing](docs/guide/reindex.md) — the full fill, and what it removes.
- [Following changes](docs/guide/following-changes.md) — batches, the resume
  point, and how a sync stops.
- [What it leaves out](docs/guide/boundaries.md) — the settings, the joins,
  and the lease that keeps one follower per sync name.
- [Troubleshooting](docs/troubleshooting.md) — the errors, by their message.
- [Roadmap](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT

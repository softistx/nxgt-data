# The kit's lifecycle

One `syncIndexes`, one `reindexAll`, one `start`, one `close` for every sync the
[config](wiring.md) named — and one promise to watch while they run.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import { createSearchKit } from '@nxgt/mongo-search-kit';
import * as collections from './models';                 // the defineCollections
import { meili } from './meili';                         // a Meilisearch client
import { articleIndex, authorIndex } from './search';    // the defineIndexes

const kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);

const search = createSearchKit(kit, {
	articles: {
		index: bindIndex(meili, articleIndex),
		transform: (article) => ({ id: String(article._id), title: article.title }),
	},
	authors: {
		index: bindIndex(meili, authorIndex),
		transform: (author) => ({ id: String(author._id), name: author.name }),
	},
});

await search.syncIndexes();             // create every index, apply its settings
await search.reindexAll();              // fill every index
const running = await search.start();   // follow every collection
void running.failed.catch(() => process.exit(1)); // await it or catch it

// …

await running.close();                  // flush and stop every sync
await kit.close();                      // the Mongo kit is still yours
```

## `syncs`

Each sync as `@nxgt/mongo-meilisearch` built it, under the key the config
used — so anything the kit does not wrap is still reachable:

```ts
search.syncs.articles.name;             // 'articles:articles'
await search.syncs.articles.reindex();  // just this one
const one = await search.syncs.authors.start();
```

## `state()`

Where each sync stands, under its key; `undefined` for one that never
reindexed:

```ts
await search.state();
// { articles: undefined, authors: undefined }

await search.reindexAll();
(await search.state()).articles?.reindexedAt; // a Date
```

## `syncIndexes(options?)`

Every index the config names brought in line with its definition — created
with its primary key when it is missing, and only the settings that differ
updated — one after another, each report under its key. It is
`@nxgt/meilisearch`'s `syncIndex` per entry, so the options and the report
are that package's:

```ts
const reports = await search.syncIndexes();
// { articles: { uid: 'articles', created: true, changed: [ 'searchableAttributes' ], … },
//   authors:  { uid: 'authors', created: false, changed: [], … } }

await search.syncIndexes({ dryRun: true });        // what it would send, sends nothing
await search.syncIndexes({ wait: { timeout: 120_000 } }); // the SDK's WaitOptions, per task
```

Run it twice and the second run sends nothing. The first index that throws
stops the rest, and the indexes after it are not looked at: a
`SearchIndexError` from `@nxgt/meilisearch` — `PRIMARY_KEY_MISMATCH` or
`TASK_FAILED` — or the SDK's own error for a Meilisearch that refused or is
not there. `dryRun` shows every **settings** difference at once, but not past
a primary-key mismatch: that one throws in a dry run too, since no setting
could make the index right.

It is a **deployment step**, like the Mongo kit's `sync()`, and it comes
first: `reindexAll` and `start` write documents, and an index a document write
creates gets the primary key but none of the definition's settings until a
sync runs — its filters and sorts are refused until then.

## `reindexAll()`

Every collection, one after another, each report under its key:

```ts
const reports = await search.reindexAll();
// { articles: { indexed: 1, skipped: 1, removed: 0 }, authors: { … } }
```

**The first that throws stops the rest, and the reports already collected go
with the rejection.** A reindex removes what a collection no longer gives, so
a half-finished run is not a state to keep going from: read the error, fix
it, run it again — a reindex that succeeded is idempotent.

It cannot run beside its own follower: `@nxgt/mongo-meilisearch` throws
`SearchSyncError` with the code `RUNNING` for a sync of the same object that
is already following, and the kit passes it through.

## `start()`

Starts every sync and resolves once they are **all** hearing changes:

```ts
const running = await search.start();
running.running.articles.ready;   // each RunningSearchSync is reachable
```

A sync that will not start closes the ones already started before the error
comes back, so a caller that catches it owns nothing:

```ts
try {
	await search.start();
} catch (error) {
	// Nothing is running: no sync to close, no leak.
}
```

A sync with nothing recorded reindexes as it starts, which on a real
collection is minutes — the syncs started before it are following changes
throughout, which is why a failure closes them rather than leaving them
behind.

## `failed`

| Member | Type | Effect |
| --- | --- | --- |
| `running` | `{ [K in keyof I]: RunningSearchSync }` | Each running sync, with its own `ready`, `closed` and `flush` |
| `failed` | `Promise<never>` | Rejects with the **first** sync that stops on an error. Never resolves |
| `flush()` | `Promise<void>` | Sends what every sync holds and records where each one is. Stops at the first that fails |
| `close()` | `Promise<void>` | Flushes, then stops every sync. Idempotent |

```ts
running.failed.catch((error: SearchSyncError) => {
	console.error({ sync: error.sync, code: error.code, cause: error.cause });
	process.exit(1); // let the supervisor restart the process
});
```

- **It must be taken.** A rejection nobody handles ends the process. The kit
  already takes each sync's own `closed`, so `failed` is the only one left to
  you — handle it.
- **It never resolves.** A clean stop is not an event to wait for, so
  `await running.failed` after `close()` waits forever. It is for `catch`, or
  for racing against your own shutdown.
- **A dropped collection leaves it silent.** `@nxgt/mongo-meilisearch` treats
  an invalidated stream as a clean stop — that sync's `closed` *resolves*
  with `'invalidated'` — and the kit forwards failures only. Watch
  `running.running.articles.closed` when a drop has to be noticed.

## `flush()` and `close()`

```ts
await running.flush(); // every sync sends what it holds, and records it
await running.close(); // flushes, then stops; or `await using running = …`
```

`flush()` stops at the first sync that fails, like `reindexAll()`: the syncs
after it in the config are neither sent nor recorded, and re-read those
changes on the next start — safe, but not free.

`close()` does not share that: it closes each sync in turn and keeps going
past one that fails. It swallows the failure `failed` already carried — a
caller should not have to wrap `close` to hear the same thing twice — and
throws anything else, including a **second** sync that fell over after
`failed` had settled, and anything that goes wrong while closing. If more
than one throws, it reports the first.

`close()` is idempotent, and `RunningSearchKit` is `AsyncDisposable`.

## A worker process

The two kits, started in order and closed in reverse:

```ts
import { createKit } from '@nxgt/mongo-kit';
import { createSearchKit } from '@nxgt/mongo-search-kit';
import type { SearchSyncError } from '@nxgt/mongo-meilisearch';
import { config } from './db';
import { searchConfig } from './search';

const kit = await createKit(config);
const search = createSearchKit(kit, searchConfig(meili));

const running = await search.start();

const stop = async () => {
	await running.close(); // flushes and records where each sync is
	await kit.close();     // the search kit never closes it
	process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// The only promise left to handle: the first sync that falls over.
await running.failed.catch(async (error: SearchSyncError) => {
	console.error({ sync: error.sync, code: error.code, cause: error.cause });
	await running.close().catch(() => undefined);
	await kit.close();
	process.exit(1);
});
```

A deployment step is the same two objects, without `start`:

```ts
await using kit = await createKit(config);
await kit.sync();                                   // the collections
const search = createSearchKit(kit, searchConfig(meili));
await search.syncIndexes();                         // the indexes
const reports = await search.reindexAll();
for (const [key, report] of Object.entries(reports)) {
	console.log(`${key}: ${report.indexed} indexed, ${report.removed} removed`);
}
```

## Signatures

```ts
interface SearchKit<S> {
	readonly syncs: ByKey<S, SearchSync>;
	state(): Promise<ByKey<S, SearchSyncState | undefined>>;
	syncIndexes(options?: SyncOptions): Promise<ByKey<S, SyncReport>>; // @nxgt/meilisearch's
	reindexAll(): Promise<ByKey<S, ReindexReport>>;
	start(): Promise<RunningSearchKit<S>>;
}

interface RunningSearchKit<S> extends AsyncDisposable {
	readonly running: ByKey<S, RunningSearchSync>;
	readonly failed: Promise<never>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

type ByKey<S, T> = { readonly [K in keyof S]: T };
```

`SearchSync`, `RunningSearchSync`, `SearchSyncState`, `ReindexReport` and
`SearchSyncError` are `@nxgt/mongo-meilisearch`'s, unchanged.

## Next

- [Wiring it over a Mongo kit](wiring.md) — the config behind all of this.
- [Troubleshooting](../troubleshooting.md) — the messages, with their fixes.

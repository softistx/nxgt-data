# @nxgt/mongo-search-kit

A search kit over [`@nxgt/mongo-kit`](https://www.npmjs.com/package/@nxgt/mongo-kit):
one config naming an index and a transform per collection, and one
`syncIndexes`, `reindexAll`, `start` and `close` for all of them.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { createSearchKit } from '@nxgt/mongo-search-kit';
import { kit } from './db';                      // the app's `createKit`
import { articleIndex, authorIndex } from './search';  // its `defineIndex`s

const search = createSearchKit(kit, {
	articles: {
		index: bindIndex(meili, articleIndex),
		// `article` is typed by the collection the key names, and the result
		// by the index this entry carries. `null` keeps a document out.
		transform: (article) =>
			article.draft ? null : { id: String(article._id), title: article.title },
	},
	authors: {
		index: bindIndex(meili, authorIndex),
		transform: (author) => ({ id: String(author._id), name: author.name }),
	},
});

const running = await search.start();   // both change streams, from one call
running.failed.catch(exit);             // await it or catch it — see Traps
```

Each collection's sync is
[`@nxgt/mongo-meilisearch`](https://www.npmjs.com/package/@nxgt/mongo-meilisearch)'s,
unchanged — the reindex, the change stream that resumes where it stopped, the
point recorded in MongoDB. What this package adds is the wiring: the
collections come from the kit, so nothing is named twice, and the syncs are
started and stopped together.

The key is the name a collection is **exported** under, the same one
`kit.db.articles` answers to. A key the kit wires no collection for does not
compile, and is refused by name at runtime too.

`createSearchKit` sends nothing: `syncIndexes`, `reindexAll` and `start` do.

> **0.x, on `@nxgt/mongo-kit` and `@nxgt/mongo-meilisearch`.** The API is
> still settling.

## Install

```sh
bun add @nxgt/mongo-search-kit @nxgt/mongo-kit @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch mongodb meilisearch zod
```

- `@nxgt/mongo-kit`: required peer. Where the collections come from.
- `@nxgt/mongo-meilisearch`: required peer. Every sync is one of its
  `createSearchSync`, and its options, errors and traps are this package's.
- `@nxgt/mongo` and `@nxgt/meilisearch`: required peers, as the two above
  need them.
- `mongodb` `>=7.0.0 <8` and `meilisearch` `>=0.62.0 <1`: required peers, the
  ranges the siblings set. `zod` is `@nxgt/mongo`'s.
- `typescript` 6: required peer, the version every `@nxgt` package pins.
- Tested against MongoDB 8.2 and Meilisearch 1.53. A **replica set** is
  needed: `start` follows a change stream, which is MongoDB's own rule.

## What it does not do

- **One database.** A kit that holds several gives `never` for its keys, as
  `kit.db` itself does, and `createSearchKit` throws naming them. Build one
  search kit per database, from a kit that wires that database alone.
- **Its own coordination between processes.** Each entry's sync takes the
  lease on its name when it starts, as `@nxgt/mongo-meilisearch` does: a
  second process starting the same kit is refused with `RUNNING` for the
  first sync whose name is held, and starts nothing. How long a lease lasts is
  each entry's `leaseMs`.
- **It does not own the Mongo kit.** Closing the search kit stops the syncs
  and nothing else: the clients, the databases and the collections are the
  Mongo kit's, and `kit.close()` is still the caller's to make.

## API

### `createSearchKit(kit, config)`

```ts
function createSearchKit<C, const I extends IndexMap<I>>(
	kit: MongoKit<C>,
	config: SearchConfig<C, I>,
): SearchKit<I>;
```

`config` is one entry per collection, under the kit's own key. An entry is
everything [`createSearchSync`](https://www.npmjs.com/package/@nxgt/mongo-meilisearch)
takes **except `collection`**, which the kit already holds: `index`,
`transform`, `toIndexId` (optional while the index's ids are strings,
required otherwise), and optionally `name`, `stateCollection`, `batchSize`,
`flushIntervalMs`, `positionIntervalMs`, `leaseMs`, `pageSize` and
`onHistoryLost`.

`SearchKit<I>`:

| Member | |
| --- | --- |
| `syncs: { [K in keyof I]: SearchSync }` | each sync as `@nxgt/mongo-meilisearch` built it, so anything this kit does not wrap is still reachable |
| `state()` | where each sync stands, under its key; `undefined` for one that never reindexed |
| `syncIndexes(options?)` | every index created and its settings applied where they differ — `@nxgt/meilisearch`'s `SyncReport` per key, `dryRun` and `wait` passed through. One after another; the first that throws stops the rest |
| `reindexAll()` | a `ReindexReport` per key. One after another, and the first that throws stops the rest |
| `start()` | every sync, resolving once they are all hearing changes |

`RunningSearchKit<I>`, also `AsyncDisposable`:

| Member | |
| --- | --- |
| `running: { [K in keyof I]: RunningSearchSync }` | each running sync, so its `ready`, its `closed` and its own `flush` are still reachable |
| `failed: Promise<never>` | rejects with the **first** sync that stops on an error, and never settles otherwise. A later failure is `close()`'s to report |
| `flush()` | sends what every sync holds, and records where each one is. Stops at the first that fails |
| `close()` | flushes, then stops every sync. Idempotent |

### Types

| Type | |
| --- | --- |
| `SearchConfig<C, I>` | the config object: a `SearchEntry` per key of `SoleCollections<C>`. A key the kit wires no collection for gets a refusal string in place of its entry, which names the key |
| `SearchEntry<Col, I>` | one entry: `Omit<SearchSyncOptions<Col, I>, 'collection'>` |
| `SoleCollections<C>` | what a kit's sole database holds, by the name each definition is exported under; `never` when the kit holds several |
| `IndexMap<I>` | the index definitions a config names, one per key. `I` is inferred from each entry's `index` alone, which is what lets a `transform` be written inline |
| `ByKey<S, T>` | `{ readonly [K in keyof S]: T }`, the shape every per-key result uses |

## What does not compile

Each is a `@ts-expect-error` case in this package's specs, beside the runtime
refusal it goes with.

- A key the kit wires no collection for — the message names the key.
- A key that is a member of the driver's `Db`, such as `command`.
- A kit that holds more than one database.

## Traps

- **A failure nobody handles is silent, not loud.** A sync that stops on an
  error rejects `failed`, and the kit takes that rejection itself — as it
  takes each sync's own `closed` — so nothing ends the process and nothing is
  printed. That index simply stops updating. `failed` is the only place the
  failure surfaces, so handle it; unhandled, the first sign is stale search
  results.
- **`failed` never resolves.** A clean stop is not an event to wait for, so
  `await running.failed` after `close()` waits forever. It is for `catch`,
  or for racing against your own shutdown.
- **A dropped collection leaves `failed` silent.** `@nxgt/mongo-meilisearch`
  treats an invalidated stream as a clean stop — `closed` *resolves* with
  `'invalidated'` — and this kit forwards failures only. That sync is dead
  and nothing settles. Watch `running.running.<key>.closed` if a drop has to
  be noticed.
- **`close()` does not report the failure `failed` already carried.** That
  one sync rejects its own `close` with what it stopped on, and the kit
  swallows it — a caller should not have to wrap `close` to hear the same
  thing twice. Every *other* failure is thrown, including a **second** sync
  that fell over after `failed` had settled, and anything that goes wrong
  *while* closing. If more than one throws, `close` reports the first of
  them.
- **A failed `start()` leaves nothing running.** The syncs already started
  are closed before the error comes back, so a caller that catches it owns
  no sync.
- **A kit cannot be started twice, nor reindexed while running** — in this
  process or in another. `@nxgt/mongo-meilisearch` throws `RUNNING` for a sync
  of the same object that is already following, or whose name another
  process holds the lease on, and the kit passes that through — with the
  lease's `holder` and `expiresAt` on it in the second case, so a standby
  waits until that lease lapses.
- **A sync that loses its lease rejects `failed` with `LEASE_LOST`.** A
  process stalled for longer than an entry's `leaseMs` (30 s) may find another
  has taken that name over; the sync stops rather than run beside it.
- **`reindexAll()` and `start()` can reject with `LEASE_LOST` too**, when a
  sync's reindex finds its lease taken over. That reindex has recorded nothing,
  and removed nothing unless the lease went while the removal itself ran;
  treat it like `RUNNING` — wait, then try again.
- **`flush()` stops at the first sync that fails, like `reindexAll()`.** A
  sync that has already fallen over rejects `flush` at once, and the syncs
  after it in the config are then neither sent nor recorded — on restart
  they re-read changes they had in hand, which is safe but not free. `close()`
  does not share this: it flushes each sync through its own `close` and keeps
  going past one that fails.

- **`reindexAll()` stops at the first failure, and reports nothing.** The
  keys already done are lost with the rejection, because a reindex removes
  what a collection no longer gives and a half-finished run is not a state to
  keep going from. Read the error, fix, and run it again — the reindexes that
  succeeded are idempotent.
- **Two kits over one collection is two syncs over one index.** The name a
  sync records its point under defaults to `<collection>:<index uid>`, so two
  search kits built from the same config share it, and its lease: the second
  is refused with `RUNNING` while the first runs. Give `name` if you mean them
  to be different.
- Everything `@nxgt/mongo-meilisearch`'s own Traps say still holds: a change
  may be applied twice, a transform that throws stops the sync, the sync owns
  its index, and Meilisearch has its own rules for ids.

## Documentation

- [Guide index](docs/README.md) — every page, and when to read it.
- [Wiring it over a Mongo kit](docs/guide/wiring.md) — the config, the keys,
  and every option an entry takes.
- [The kit's lifecycle](docs/guide/lifecycle.md) — `reindexAll`, `start`,
  `failed`, `flush` and `close`.
- [Troubleshooting](docs/troubleshooting.md) — the errors, by their message.
- [Roadmap](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT

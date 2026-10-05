# Roadmap

Where `@nxgt/mongo-meilisearch` is going. A direction, not a commitment: the
version an item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **Partial updates** — a change sends the whole document the transform gives,
  never a patch. The transform is a function of the document alone, which is
  also what makes a change safe to apply twice.
- **Keeping the index's settings** — that is `@nxgt/meilisearch`'s `syncIndex`
  / `syncIndexes`, run as a deployment step. This package writes documents.
- **Joining other collections into a document** — the transform may read them,
  but a change to one of them does not reach the index: the sync follows the
  collection it was given. Run a sync per collection that has to move the
  index.
- **`createSearchSyncs` over several databases** — a Mongo holding more than
  one gives `never` for its keys, and `createSearchSyncs` throws naming them.
  Build one `createSearchSyncs` per database, from a Mongo that wires that
  database alone.
- **`createSearchSyncs` owning the Mongo** — closing the search syncs stops
  them and nothing else: the clients, the databases and the collections
  belong to the Mongo, and `mongo.close()` stays the caller's.
- **A lock of its own for `createSearchSyncs`** — the lease already provides
  it: each sync takes a lease on its name, so a second process starting the
  same syncs is refused with `RUNNING`.
- **One index fed by two collections, or by another writer** — a reindex
  removes every document the collection does not give it, whoever wrote it.
  The sync owns its index.

## Shipped

- **Several collections from one config** — `createSearchSyncs(mongo, config)`
  over what `@nxgt/mongo`'s `openMongo` returns: one entry per collection,
  under the key the Mongo wires it as, and one `syncIndexes`, `reindexAll`,
  `start` and `close` for all of them, with `failed` for the first sync that
  stops. It is `@nxgt/mongo-search-kit`, folded in and renamed
  (`createSearchKit` is `createSearchSyncs`), whose own roadmap is carried
  here: `syncIndexes()` and one follower per sync name across processes came
  with its 0.2.0, and the package is now a deprecated re-export — 0.5.0.
- **A standby waits exactly for the holder** — a `RUNNING` the lease refused
  carries `holder` and `expiresAt`, read from the lease document, so a process
  waiting for the name sleeps until the holder's lease lapses instead of a
  fixed time; both are `undefined` on a sync object's own refusal, where only
  its `close()` frees the name — 0.4.0.
- **A lease on a sync name, renewed while it runs** — `start()` and
  `reindex()` take a lease on the sync's name, kept in the state collection
  and timed by the server, renewed every third of the new `leaseMs` option
  (default 30 s); a second process gets `RUNNING` naming the holder, a process
  that dies is taken over once its lease lapses, and a sync whose lease was
  taken stops with the new `LEASE_LOST` code; a reindex asks the server that
  the lease is still its own before it removes documents or records where
  following resumes — 0.3.0.
- **A transform that gives back something that is not a document has its own
  code** — `SearchSyncErrorCode` gains `NOT_A_DOCUMENT`, naming the sync and
  the document and reporting the shape of what came back, never its value, so
  a transform written wrong is no longer the same `FAILED` a Meilisearch
  outage is — 0.2.0.
- **Documentation that travels with the package** — a guide page for the
  sync's lifecycle, following a collection's changes, `reindex` and where the
  package's boundaries are, a troubleshooting page whose headings are the
  exact error text, and this roadmap, installed in `docs/` rather than left on
  GitHub — 0.1.7.
- **`@nxgt/mongo` 0.15.0** — a deduplicated file write two callers cannot
  both win — 0.1.6.
- **`@nxgt/mongo` 0.14.0** — files under its `./gridfs` subpath — 0.1.5.
- **`@nxgt/mongo` 0.13.0** — `upsert` in one round trip — 0.1.4.
- **A reindex's cost written down** — it holds one id per live document in
  memory and pages the whole index, so it is a deployment step — 0.1.3.
- **`@nxgt/mongo` 0.12.0** — strings from outside read from the schema —
  0.1.2.
- **A peer range that matches what it is built against** — `@nxgt/mongo`
  `^0.11.0`, which has the `position` this package records while a collection
  is quiet — 0.1.1.
- **First release** — `createSearchSync` with a transform typed by both
  definitions (`null` keeps a document out), `reindex`, and `start`, which
  follows the collection's changes in batches and resumes from a point
  recorded in MongoDB, reindexing when the server's history no longer reaches
  it; `SearchSyncError` with `HISTORY_LOST`, `ID_MISMATCH`, `RUNNING` and
  `FAILED` — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo-meilisearch/CHANGELOG.md) — it is not in
the published package, only in the repository.

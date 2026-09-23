# @nxgt/drizzle-meilisearch

## 0.2.1

### Patch Changes

- Updated dependencies [[`c065f43`](https://github.com/softistx/nxgt-data/commit/c065f430bdc41923fb8562cd348a27d396b11703), [`348c1f3`](https://github.com/softistx/nxgt-data/commit/348c1f3672f2a596abecaa1a7d08dcdf04a55696)]:
  - @nxgt/meilisearch@0.4.0

## 0.2.0

### Minor Changes

- [#90](https://github.com/softistx/nxgt-data/pull/90) [`7fd298c`](https://github.com/softistx/nxgt-data/commit/7fd298ccb60930690864a24f597a92b0b6c27e7b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `reindexAll({ onPage })` reports where a reindex is: after each page is applied, `onPage` is called with the running `pages`, `indexed` and `skipped`, and awaited when it returns a promise. A callback that throws stops the reindex — it rejects as a `SearchSyncError` with `FAILED`, the message `failed reporting progress: …` and the callback's error as `cause`, even when that error is itself a `SearchSyncError` — which is also how to stop one on purpose. An empty table is one page: `onPage` is called once, with zeros. `ReindexOptions` and `ReindexProgress` are exported.

### Patch Changes

- Updated dependencies [[`c4069fc`](https://github.com/softistx/nxgt-data/commit/c4069fcdddc6efb3e74ec352f42c094a7d285fb1)]:
  - @nxgt/meilisearch@0.3.0

## 0.1.0

### Minor Changes

- [#81](https://github.com/softistx/nxgt-data/pull/81) [`fabd386`](https://github.com/softistx/nxgt-data/commit/fabd38665927e852d3eb4998ab2fce6dd8703ae7) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: a Meilisearch index kept in step with a PostgreSQL table, by
  the calls an application already makes.
  
  `createSearchSync({ repository, index, transform, toIndexId })` does no I/O at
  all — it takes a repository from `@nxgt/drizzle` and an index from
  `@nxgt/meilisearch`, both already bound — and gives back `reindexAll()` plus
  one call per write: `indexRow`, `indexRows`, `removeRow`, `remove`,
  `removeMany`. The `transform` is typed by both sides, may be async, and
  returns `null` to keep a row out of the index — and take it out if it was in.
  
  `reindexAll` pages the table, sends every row the transform keeps, then reads
  the index back and removes what the table no longer gives it, soft-deleted
  rows included; it reports `{ indexed, skipped, removed }`. It waits for every
  batch, because what it removes is decided by that read. The per-write calls
  do not: `wait` defaults to `false`, since indexing in Meilisearch is
  asynchronous and a request that has just written a row should not hold its
  response open for it.
  
  Deliberately smaller than `@nxgt/mongo-meilisearch`: there is no `start()`, no
  stored position and nothing followed. PostgreSQL offers no change feed a
  library could read without owning the deployment — logical replication wants
  a slot, a publication and a connection of its own, and `LISTEN`/`NOTIFY` is
  not durable — so this package removes the boilerplate around a write and
  leaves the decision of *when* to index to the application, which just wrote
  the row. `docs/roadmap.md` says so with the reasons.
  
  `toIndexId` is required here where the Mongo bridge defaults it to `String`:
  Drizzle 1.0's column types do not carry `.primaryKey()`, so nothing at the
  type level knows which column the id is, and a guessed index id is a document
  that could never be taken out again.
  
  `indexRows` keys its entries by index id, last one wins: two states of the
  same row in one call — which a caller batching its writes can produce — would
  otherwise have the document the call had just added deleted at the end of the
  same batch.
  
  `SearchSyncError` carries a `code` — `ID_MISMATCH`, `NOT_A_DOCUMENT` or
  `FAILED` — and the sync's name; every refusal at wiring time is a bare
  `TypeError` naming the call it was given to, and `reindexAll`'s names the sync
  as well, so an application running several knows which one refused. 38 tests
  against a real PostgreSQL (PGlite, in process) and a real Meilisearch, and 20
  `@ts-expect-error` cases for what the types refuse.

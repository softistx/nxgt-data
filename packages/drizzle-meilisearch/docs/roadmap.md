# Roadmap

Where `@nxgt/drizzle-meilisearch` is going. A direction, not a commitment: the
version an item shipped in is the only number on this page.

The scope is narrow on purpose. This package removes the collage around a
manual synchronisation — the transform, the index id, the batching, the delete
of a row that stopped qualifying — and leaves the decision of *when* to index
to the application, which already knows: it just wrote the row. **Not planned**
below is where that line is drawn, and why.

## Now

_Nothing in progress._ The first release is what is in flight.

## Next

- **A reindex that says where it is** — `reindexAll` pages the whole table,
  waits for every batch to be applied and gives its counts only when it is
  done, so a large table is a long silence. A callback per page, carrying the
  running counts, would let a deployment step or a script report progress
  without changing what the call does.

## Later

- **A source that is not a repository** — `SyncRepository` is already written
  as its own shape, `table` plus `paginateByCursor`, rather than as
  `Repository<TTable>`, so anything that pages rows by cursor nearly fits
  today; `table` is read only to name the sync. Accepting a paging function,
  with `name` given, would let a sync feed an index from a filtered or joined
  query instead of a whole table.

## Not planned

- **Following the table's changes, a `start()` and a resume point** — the one
  that matters. `@nxgt/mongo-meilisearch` follows a MongoDB change stream and
  records where it stopped; PostgreSQL offers nothing equivalent a library
  could read without owning the deployment. Logical replication wants a
  replication slot, a publication, `wal_level=logical` and a connection that
  is not the pooled one the application uses; `LISTEN`/`NOTIFY` wants a trigger
  per table, is not durable, and drops everything sent while nobody was
  listening. So there is no change feed here, and none pretended: index after
  the write, with `indexRow` or `indexRows`.
- **A stored position, and `state()`** — there is nothing to resume from,
  because nothing is followed. `reindexAll` is the way back to a correct index.
- **Reading the primary key from the table, so `toIndexId` could be optional**
  — Drizzle 1.0's column types do not carry `.primaryKey()`, which is why
  `@nxgt/drizzle`'s own `PrimaryKeyOf` falls back to the key `id`. A guessed
  index id writes documents under an id nothing can take out again; one line
  per sync says it outright, and says it where the index's id type can check
  it.
- **A repository wrapper whose writes index themselves** — a `create` that
  also sends the document reads well until it throws: the row is committed,
  the index write is not, and the caller is handed an error for work it did
  not ask for, at a point it cannot undo. It would also hide when the index is
  written, which is the single decision this package deliberately leaves with
  the application.
- **Indexing inside the transaction that wrote the row** — a Meilisearch write
  is not part of a PostgreSQL transaction, and a rollback cannot undo it: the
  index would hold a row the table never kept. Index after the transaction
  commits.
- **Several tables into one index** — one sync is one repository and one index.
  `reindexAll` removes every document the repository did not give it, whoever
  wrote it, so two syncs sharing an index would each take out what the other
  added.

## Shipped

- **First release** — `createSearchSync`, which builds nothing and opens
  nothing: the repository and the index are already bound, and no call reaches
  PostgreSQL or Meilisearch until a method is used. `reindexAll` pages every
  live row through the transform, sends it in batches, and then takes out the
  documents the index holds and the table no longer gives it — soft-deleted
  rows included — reporting `indexed`, `skipped` and `removed`. `indexRow` and
  `indexRows` after a write — the list keyed by index id, last state winning, so
  two states of one row in a call cannot have the add undone by the delete —
  `removeRow`, `remove` and `removeMany` for a row that is gone, all with
  `wait` defaulting to `false`, so a request that has just written a row does
  not hold its response open for Meilisearch. The
  transform is typed by both the table's row and the index's document, and
  `null` keeps a row out of the index and takes it out if it was in;
  `SearchSyncError` carries the sync's name with `ID_MISMATCH`,
  `NOT_A_DOCUMENT` and `FAILED` — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/drizzle-meilisearch/CHANGELOG.md) — it is not in
the published package, only in the repository.

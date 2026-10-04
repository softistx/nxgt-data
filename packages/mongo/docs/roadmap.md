# Roadmap

Where `@nxgt/mongo` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **An aggregation pipeline builder** — `distinct`, `groupBy` and `populate`
  cover what most collections need typed; anything past them is the driver's
  own `.aggregate()`, reachable on the collection and untouched.
- **Migration files, or a CLI** — migrations are a list in code, run from a
  script of yours: nothing reads a directory, and there is no binary to
  configure.
- **Checking a read against the schema** — `validate` is about writes. A
  document written by `raw`, by a migration or before a field existed comes
  back typed as though the field were there; parse what you read when it
  matters.
- **`$setOnInsert` in a patch** — `update` never inserts, so there is nothing
  for it to apply to; a document that is not there is a `NotFoundError`.
  `upsert` is the call built for that, and it fills the stamps.
- **Files through the driver's own GridFS** — measured on mongodb 7.6.0, no
  GridFS call takes a session, so a file write could not run in the
  transaction it was asked to run in. `@nxgt/mongo/gridfs` writes and reads
  the chunk documents itself, which is what makes a file write transactional.
- **Creating a bucket's indexes on the first write** — this package writes
  chunk documents itself, so nothing is created behind a write; `syncIndexes()`
  at start-up, or a bucket bound with `autoSync`, is what creates
  `files_id_1_n_1`. A bucket without it warns once per process rather than
  being quietly slow.
- **An audit journal kept by this package** — who changed what is already
  within reach: `actors` stamps `createdBy`, `updatedBy` and `deletedBy` from
  `collection.as(actor)`, and an `after` hook sees each write, its actor and
  its session, so an application can write its own journal in the same
  transaction, keeping only what it needs for as long as it needs. A journal
  built in would add a write to every write, and a retention policy nobody
  asked for.
- **A recursive schema as a validator** — MongoDB's `$jsonSchema` has no
  `$ref`, so a schema that refers to itself cannot be expressed;
  `toMongoJsonSchema` throws rather than writing a validator the server would
  refuse.
- **A typed `discoverCollections`** — it reads the file system under Bun, has
  no types and does not survive bundling. It is for scripts; an application
  wires its collections in the configuration, as `import * as collections`,
  where they stay typed.
- **Closing a client the configuration handed over** — the Mongo gives back only
  the clients it opened, `await using` included. A client you opened is closed
  where it was opened.
- **A transaction across two clients** — MongoDB refuses a session a client
  does not own, so a transaction reaches one client's databases and `{ on }`
  names which. Two databases on one URI share a client and need no `{ on }`.
- **`autoSync` as a production setting** — it is for tests and development.
  In production `sync()` is a deployment step: it needs `dbAdmin`, and an
  index build does not run in a transaction.
- **Wiring a collection under a name the driver's `Db` already answers to** —
  refused by the types where the configuration is written, and again by
  `openMongo` against the object itself, so `mongo.db.command(…)` is always the
  driver's.
- **An actor on a bucket** — `@nxgt/mongo/gridfs` stamps no `*By` field, so
  `as(actor)` has nothing to write on a file. Who uploaded one belongs in
  its metadata, typed by the bucket's schema.
- **`sync()` syncing buckets** — `sync()` applies collection definitions and
  keeps its report shape; a bucket is not one. `syncBuckets()` is the step
  beside it.
- **A `dryRun` for `syncBuckets()`** — a bucket's index creation has none to
  pass on: it creates what is missing and reports what was there.

## Shipped

- **The wiring of `@nxgt/mongo-kit`, folded in** — `defineMongo` checks a
  configuration of one or several databases and freezes it; `openMongo` opens
  the clients and gives back a `Mongo` whose `db` is the driver's own with
  every collection and every GridFS bucket typed on it, plus `as(actor)`,
  `withSession`, `transaction`, `sync()`, `syncBuckets()`, `ping()` and
  `close()`; `discoverCollections` reads definitions for scripts; and every
  refusal is a `WiringError`, a `TypeError` with a `code`. It is what
  `@nxgt/mongo-kit` shipped through 0.4.x, renamed (`createKit` is
  `openMongo`, `defineConfig` is `defineMongo`, `MongoKit` is `Mongo`, `KitError`
  is `WiringError`), and that package now only re-exports it — 0.19.0.
- **No update writes `_id`** — `update`, `updateMany` and `upsert` refuse a
  patch that names `_id`, as a field or through any operator, even as
  `undefined`, with a `TypeError` naming the call and the collection before
  anything is sent or any hook runs, and their types leave it out, all but a
  top-level `_id: undefined`; an upsert's filter may name the `_id` an insert
  gets, and then matches on it too. It used to reach the
  server and come back as a plain `DataError` (`ImmutableField`). The
  driver's own methods are untouched — 0.18.0.
- **A bucket with no chunk index says so, once** — the first read of a bucket
  whose chunks collection has no `files_id_1_n_1` emits one `process` warning,
  `NxgtGridFSMissingIndex`, naming the bucket and the collection, so a read
  that scans the whole bucket is no longer silent; `syncIndexes()` at start-up,
  or binding with `autoSync`, is what it asks for — 0.17.0.
- **Every refusal names the call and the collection** — a pagination number, a
  cursor and a GridFS chunk that holds no bytes each say which listing, which
  collection, and which file refused them, instead of a sentence three calls
  shared; and an upsert the server answers with no document is a `DataError`
  rather than a `TypeError`, so the one thing that should never happen no
  longer wears the class the caller's own mistakes wear — 0.17.0.
- **A connect a close interrupted is a `ConnectionError`** — carrying
  `code: 'CONNECTION'` and an `instanceof DataError` like the rest, so the one
  failure that is worth retrying is recognised without matching the sentence;
  it holds no URI, and MongoDB's own refusal to connect is still the driver's
  error, unchanged — 0.16.0.
- **Documentation that travels with the package** — a guide page per area,
  from collections and documents to transactions, change streams, migrations
  and GridFS, a troubleshooting page whose headings are the exact error text,
  and this roadmap, installed in `docs/` rather than left on GitHub — 0.15.1.
- **A deduplicated file write two callers cannot both win** — `putOnce`
  stores a file under the id its bytes decide, the server elects the winner,
  and the caller that loses is handed the stored copy — 0.15.0.
- **Files, under `@nxgt/mongo/gridfs`** — a bucket described once, metadata
  that is a schema, a typed handle, `Range`-aware `serve`, cursor pagination,
  and writes that run inside a transaction — 0.14.0.
- **`upsert` writes nothing extra on the half that matched** — a stored
  document missing a field is no longer filled from the schema's default, nor
  credited to whoever happened to upsert it — 0.13.1.
- **`upsert(filter, values)`** — the live document that matches, changed, or
  a new one, in one round trip, with no read to go stale in between — 0.13.0.
- **Two behaviours written down** — a read is never checked against the
  schema, and `$setOnInsert` does nothing — 0.12.1.
- **Strings from outside read from the schema** — a 24-hex id becomes an
  `ObjectId` and a date string a `Date`, in ids, filters, writes and hooks,
  so a handler no longer parses before it queries; `coerce: false` turns it
  off — 0.12.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo/CHANGELOG.md) — it is not in
the published package, only in the repository.

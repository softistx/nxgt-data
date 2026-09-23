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

## Shipped

- **No update writes `_id`** — `update`, `updateMany` and `upsert` refuse a
  patch that names `_id`, as a field or through any operator, even as
  `undefined`, with a `TypeError` naming the call and the collection before
  anything is sent or any hook runs, and their types leave it out; an
  upsert's insert takes its `_id` from the filter. It used to reach the
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

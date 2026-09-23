# Roadmap

Where `@nxgt/mongo-kit` is going. A direction, not a commitment: the version
an item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **A typed `discoverCollections`** — it reads the file system under Bun, has
  no types and does not survive bundling. It is for scripts; an application
  wires its collections in the configuration, as `import * as collections`,
  where they stay typed.
- **Closing a client the configuration handed over** — the kit gives back only
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
  `createKit` against the object itself, so `kit.db.command(…)` is always the
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

- **Files beside the collections** — `@nxgt/mongo/gridfs` buckets declared
  in the configuration as `buckets`, reached off the kit the way a collection
  is, typed by their metadata and in the kit's session, so a file write
  joins a transaction with the documents around it; `bucketOptions` for
  every bucket of a database, and `syncBuckets()` creating their indexes
  beside `sync()`. A bucket has no actor to stamp, so only the session
  carries over — 0.4.0.
- **`ping()`** — one call that says whether each database the kit wires
  answers, and how long it took, under its name, for a health endpoint that
  does not reach for the driver itself; it never throws, and keeps its
  deadline even for a client that was handed over unconnected — 0.3.0.
- **Every refusal is a `KitError`, with a code** — `CONFIG`, `COLLISION`,
  `NO_DATABASE`, `SEVERAL_DATABASES`, `TRANSACTION`, `DERIVED` or `DISCOVERY`,
  beside the database and the key it is about, so a caller switches on the
  code instead of matching the sentence; it extends `TypeError`, which these
  were before, so a `catch` written against the old ones still catches them —
  0.2.0.
- **Documentation that travels with the package** — a guide page for the
  configuration, the `db` scope, actor and transactions, and `sync()`, a
  troubleshooting page whose headings are the exact error text, and this
  roadmap, installed in `docs/` rather than left on GitHub — 0.1.5.
- **`@nxgt/mongo` 0.15.0** — a deduplicated file write two callers cannot
  both win — 0.1.4.
- **`@nxgt/mongo` 0.14.0** — files under its `./gridfs` subpath — 0.1.3.
- **`@nxgt/mongo` 0.13.0** — `upsert` in one round trip — 0.1.2.
- **`@nxgt/mongo` 0.12.0** — strings from outside read from the schema —
  0.1.1.
- **First release** — `defineConfig` checking a configuration of one or
  several databases and freezing it, and `createKit` giving a `db` that is the
  driver's own with every collection typed on it, plus `as(actor)`,
  `withSession`, `transaction`, `sync()` and `close()`; `discoverCollections`
  for scripts — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo-kit/CHANGELOG.md) — it is not in
the published package, only in the repository.

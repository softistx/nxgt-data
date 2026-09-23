# Roadmap

Where `@nxgt/mongo-search-kit` is going. A direction, not a commitment: the
version an item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **A search kit over several databases** — a kit holding more than one gives
  `never` for its keys, and `createSearchKit` throws naming them. Build one
  search kit per database, from a kit that wires that database alone.
- **Owning the Mongo kit** — closing the search kit stops the syncs and
  nothing else: the clients, the databases and the collections belong to the
  Mongo kit, and `kit.close()` stays the caller's.
- **A lock of its own** — the bridge's lease already provides it: each sync
  `@nxgt/mongo-meilisearch` builds takes a lease on its name, so a second
  process starting the same kit is refused with `RUNNING`. This package wires
  the syncs a kit needs and does not move that boundary.

## Shipped

- **One follower per sync name, across processes** — each entry's sync takes
  `@nxgt/mongo-meilisearch` 0.3.0's lease on its name, so a second process's
  `start()` or `reindexAll()` is refused with `RUNNING`, a sync whose lease
  was taken stops with `LEASE_LOST`, and `leaseMs` is an entry option like
  the others — 0.2.0.
- **`syncIndexes()`** — one call that brings every index the kit wires in step
  with its definition, the way the Mongo kit's `sync()` does for the
  collections, so a deployment step is two calls and not one per index; each
  report is `@nxgt/meilisearch`'s, under its key, and `dryRun` shows every
  difference without sending anything — 0.2.0.
- **Documentation that travels with the package** — a guide page for wiring
  the syncs and one for their lifecycle, a troubleshooting page whose headings
  are the exact error text, and this roadmap, installed in `docs/` rather than
  left on GitHub — 0.1.5.
- **`@nxgt/mongo` 0.15.0 and the packages it carries** — a deduplicated file
  write two callers cannot both win — 0.1.4.
- **`@nxgt/mongo` 0.14.0 and the packages it carries** — files under its
  `./gridfs` subpath — 0.1.3.
- **`@nxgt/mongo` 0.13.0 and the packages it carries** — `upsert` in one round
  trip — 0.1.2.
- **`@nxgt/mongo` 0.12.0 and the packages it carries** — strings from outside
  read from the schema — 0.1.1.
- **First release** — `createSearchKit(kit, config)`, one entry per collection
  under the key the kit wires it as, and one `reindexAll`, one `start` and one
  `close` for all of them — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/mongo-search-kit/CHANGELOG.md) — it is not in
the published package, only in the repository.

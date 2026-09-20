# Roadmap

Where `@nxgt/drizzle` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

- **MySQL** — `createRepository`, pagination and `withTransaction` under
  `@nxgt/drizzle/mysql`, throwing the same error classes as
  `@nxgt/drizzle/pg`, so an `instanceof` works across dialects.
- **SQLite** — the same surface under `@nxgt/drizzle/sqlite`.

## Not planned

- **Drizzle 0.x** — this package is built on Drizzle 1.0's column types and
  relational queries, which 0.x does not have. The required peer is
  `drizzle-orm >=1.0.0-rc.4 <2`.
- **A driver of its own** — any Drizzle driver does (node-postgres,
  postgres-js, PGlite, Neon…), and a library that shipped one would give an
  app two copies of drizzle-orm and an `is()` that fails for one of them.
- **Reading the primary key off the table** — Drizzle 1.0's column types do
  not carry `.primaryKey()`, so nothing in the type says which column it is.
  The repository uses `id`, and `primaryKey` names another; a table whose key
  is elsewhere fails at the first call by id, with a message naming the option.
- **Signed cursors** — a cursor is encoded, not signed, deliberately: a forged
  one can still only ask for rows the query's own `where` allows, so signing
  would add a secret to configure and take nothing away.
- **A page and its total in one query** — `paginate` sends the count and the
  read together, but two queries are still not one snapshot. Run it inside a
  `repeatable read` transaction when `total` has to be exact.

## Shipped

- **Documentation that travels with the package** — a guide page for
  repositories, the schema helpers, pagination, transactions and the error
  classes, a troubleshooting page whose headings are the exact error text, and
  this roadmap, installed in `docs/` rather than left on GitHub — 0.1.2.
- **Behaviour that was measured and written down** — `findById` with a value
  the column's type refuses throws rather than reading nothing, and
  `paginate`'s two queries run together — 0.1.1.
- **First release** — typed repositories over a Drizzle table
  (`createRepository`), offset and cursor pagination, `withTransaction`,
  errors you can `instanceof` with `toDataError` mapping PostgreSQL's
  constraint violations, and the `id()`, `timestamps()` and `softDelete()`
  column helpers — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/drizzle/CHANGELOG.md) — it is not in
the published package, only in the repository.
